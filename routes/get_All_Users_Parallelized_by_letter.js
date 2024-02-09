const Transform = require('stream').Transform
const util = require('util')

const { stringify, parse } = require("csv")
const Utils = require("../Utils")
const fs = require("fs")
const OktaApiUtils = require("../OktaApiUtils")

module.exports = function (app, parent) {

  app.get('/get_All_Users_Parallelized_by_letter', async (req, res) => {

    const lettersArray = ['<A','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];

    const benchmarkStart = performance.now()

    const allPromiseResults = await Promise.allSettled(
      lettersArray.map(async letter=>{
        return getUserLetter(letter)
      })
    )

    const outputFileName = `allUsers_letters-combined_${parent.OKTA_DOMAIN}_${Utils.getDateString()}.csv`
    const outputFileNamePath = `${parent.exportsDir}/${outputFileName}`
    
    Utils.writeFileLine(outputFileNamePath, getUserColumns() .join(','))

    let totalUserCount = 0
    let fileList = []
    for (const result of allPromiseResults) {
      if(result.status === "fulfilled"){
        fileList.push(result.value.file)
        totalUserCount += result.value.userCount
      }
    }

    const combineBenchmarkStart = performance.now()
    await combineFilesIntoOne(fileList, outputFileNamePath)
    const combineBenchmarkComplete = Utils.outputBenchmark(combineBenchmarkStart)

    const benchmark = Utils.outputBenchmark(benchmarkStart)
    const logMessage = `<PRE>${totalUserCount} users fetched. total time: ${benchmark} seconds, file combine time: ${combineBenchmarkComplete} seconds
    
    ${JSON.stringify(allPromiseResults,null,4)}
    `

    console.log(logMessage)
    res.send(logMessage)
  })

  async function getUserLetter(letter){
    if(letter === '<A'){
      return getUserByFilterLetter('lt A', `profile.lastName lt "A"`)
    }
    //status eq "ACTIVE" and 
    return getUserByFilterLetter(letter, `profile.lastName sw "${letter}"`)
  }
  
  async function getUserByFilterLetter(letter,filter){
    
    return new Promise(async (resolve, reject)=>{
    
      const letterBenchmarkStart = performance.now()
      
      try{
        let allUsersCollection = await parent.oktaClient.userApi.listUsers({search:filter})

        const allUsersCsv = stringify({ header: true, columns: getUserColumns() })

        allUsers = await Utils.getCollectionDataProcessor(allUsersCollection, user=>{
          let output= [
            //user?.type?.id,
            user.id,
            user.profile.firstName,
            user.profile.lastName,
            user.created,
            user.activated,
            user.lastLogin,
            user.statusChanged,
            user.passwordChanged,
            user.lastUpdated,
            user?.credentials?.provider?.type,
            user.status,
            user.profile.login,
            user.profile?.SourceType,
            user.profile?.applicationName,
            user.profile?.userStatusChangeReason,
          ]
          allUsersCsv.write(output)
          return output
        })
        const csvUsersOutputFile = `allUsers_${parent.OKTA_DOMAIN}_Letter_${letter}_${Utils.getDateString()}.csv`
        const csvUsersFilepath = `${parent.exportsDir}/${csvUsersOutputFile}`
        const csvUsersWritableStream = fs.createWriteStream(csvUsersFilepath)
        allUsersCsv.pipe(csvUsersWritableStream)

        allUsersCsv.on('finish', ()=>{
            resolve({
              letter: letter,
              file:csvUsersOutputFile, 
              userCount: allUsers.length, 
              benchmark: Utils.outputBenchmark(letterBenchmarkStart)
            })
        })
        allUsersCsv.end()
      }catch(err){
        console.log(err)
        reject(err)
      }

    })
  }

function getUserColumns(){
  return [
    //"type id",
    "userId",
    "firstName",
    "lastName",
    "created",
    "activated",
    "lastLogin",
    "statusChanged",
    "passwordChanged",
    "lastUpdated",
    "credential provider type",
    "status",
    "login",
    "SourceType",
    "applicationName",
    "userStatusChangeReason",
  ]
}

// Transform streamer to remove first line
function RemoveFirstLine(args) {
  if (! (this instanceof RemoveFirstLine)) {
      return new RemoveFirstLine(args);
  }
  Transform.call(this, args);
  this._buff = '';
  this._removed = false;
}
util.inherits(RemoveFirstLine, Transform);

RemoveFirstLine.prototype._transform = function(chunk, encoding, done) {
  if (this._removed) { // if already removed
      this.push(chunk); // just push through buffer
  } else {
      // collect string into buffer
      this._buff += chunk.toString();

      // check if string has newline symbol
      if (this._buff.indexOf('\n') !== -1) {
          // push to stream skipping first line
          this.push(this._buff.slice(this._buff.indexOf('\n') + 2));
          // clear string buffer
          this._buff = null;
          // mark as removed
          this._removed = true;
      }
  }
  done();
}

}