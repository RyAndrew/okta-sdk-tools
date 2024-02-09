require('dotenv').config()
const { stringify } = require("csv")
const { parse } = require("csv")
const okta = require('@okta/okta-sdk-nodejs')
const fs = require("fs")
const Utils = require("./Utils")

const nodeFetch = require('node-fetch')
const https = require('node:https')
const httpsAgent = new https.Agent({
	keepAlive: true,
  maxSockets: 300
})
//override to pass request in response event
okta.DefaultRequestExecutor = class extends okta.DefaultRequestExecutor {
  fetch(request) {

    request.walltimeStartRequestTime = new Date()
    
    this.emit('request', request)
    request.agent = httpsAgent
    return nodeFetch(request.url, request).then(response => {
      this.emit('response', response, request)
      return this.parseResponse(request, response)
    })
  }
}

const express = require('express')
const app = express()
const port = process.env.PORT || 3000

const oktaClient = new okta.Client({
  orgUrl: 'https://'+process.env.OKTA_DOMAIN,
  token: process.env.OKTA_TOKEN,
  requestExecutor: new okta.DefaultRequestExecutor({maxRetries: 3}),
  defaultCacheMiddlewareResponseBufferSize: 5 * 1024 * 1024,
  cacheMiddleware: null
})

//debug logging for all api calls and rate limiting events
oktaClient.requestExecutor.on('backoff', (request, response, requestId, delayMs) => {
  console.log(`Backoff ${delayMs} ${requestId}, ${request.url}`)
})

oktaClient.requestExecutor.on('resume', (request, requestId) => {
  console.log(`Resume ${requestId} ${request.url} ${request?.headers?.['X-Okta-Retry-Count'] ? (request?.headers?.['X-Okta-Retry-Count'] + ' retries') : ''}`)
})

//oktaClient.requestExecutor.on('request', (request) => {
   //console.log(`Requesting ${request.url}`)
   //console.log(request)
//})

oktaClient.requestExecutor.on('response', (response, request) => {
  const elapsedMs = Utils.roundTime2((Date.now() - request.walltimeStartRequestTime)/1000)
  console.log(`${request.httpMethod} ${request.url}, response ${response.status}, time ${elapsedMs}`)
})


const exportsDir = './exports'
// check if exports directoy exists in root. if not, creates one
if (!fs.existsSync(exportsDir)){
  console.log('exports dir not found, creating...')
  fs.mkdirSync(exportsDir);
}

app.use('/exports',express.static(exportsDir))
app.use(express.urlencoded({ extended: true }))

parent = {
  exportsDir: exportsDir,
  oktaClient: oktaClient,
  OKTA_DOMAIN: process.env.OKTA_DOMAIN,
}

//pull in all the scripts from the routes dir
const normalizedPath = require("path").join(__dirname, "routes")
require("fs").readdirSync(normalizedPath).forEach(function(file) {
  console.log(`autorouting ${file}`)
  require("./routes/" + file)(app, parent)
})

//for root route show all autorouted urls
app.get('/', async (req, res) => {

  let pathArray = []
  app._router.stack.forEach(route=>{
    
    let routePath = route?.route?.path
    if(routePath && routePath.length > 1){
      pathArray.push(routePath.substring(1))
    }
  })

  pathArray = Utils.sortArrayCaseInsensitive(pathArray)

  let output = ''
  pathArray.forEach(path=>{
      output += `<a href="/${path}" target="_blank">${path}</a><BR>\r\n`
  })
  res.send(output)
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})