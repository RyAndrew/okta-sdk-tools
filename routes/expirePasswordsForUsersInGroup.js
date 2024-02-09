const { stringify, parse } = require("csv")
const Utils = require("../Utils")
const fs = require("fs")
const OktaApiUtils = require("../OktaApiUtils")

//      Script Operation:
//          "expirePasswords_PROD_step1_GetAllUsersForAllGroups"
//              1. Get all users in a group, save to CSV file
//          "expirePasswords_PROD_step2_ReadCsvFindUsersNotInGroups"
//              2. Iterate over List / CSV file to determine if:
//                  a. users are in ACTIVE, SUSPENDED, or LOCKED_OUT status depending on the required parameter
//                  b. check passwordLastChange date against input "PasswordLastChangeDateBefore"
//              3. Save results to CSV file "Work File" csv
//          "expirePasswords_PROD_step3_ExpireUsersFromCsv"
//              4. Iterate over the "Work File" csv to perform the password expiration on all users
//                  a. for each password expire operation, save a line to a "Results" file to allow resuming where you left off in the event of a major failure
//          expirePasswords_PROD_step4_ViewFailedUsers
//              5. Get all user records for failures for further analysis
//          expirePasswords_PROD_step5_expireAllSuspendedUsers
//              6. Unsuspend, Expire, Suspend all users meeting expiration criteria but are in SUSPENDED status
//          expirePasswords_PROD_step7_expireAllLockedOutUsers
//              7. Unlock, Expire all users meeting expiration criteria but are in LOCKED_OUT status

module.exports = function (app, parent) {

  let runActive = false
  
  app.get('/expirePasswords_PROD_step1_GetAllUsersForAllGroups', async (req, res) => {

    let benchmarkStart = performance.now()

    const groups = [
        'Group Name Here'
    ]

    const groupResults = await Promise.allSettled(
      groups.map(async groupName=>{
          const groupId = await OktaApiUtils.getGroupIdFromName(parent, groupName)
  
          if(groupId === null){
              console.log(`Group name ${groupName} not found`)
              return {
                  groupName: groupName, 
                  result: 'group not found'
              }
          }

          return await OktaApiUtils.writeGroupUsersToCsv(parent, groupName, groupId )

      })
    )
    

    //strip out user data from output, effcectively only show user count
    groupResults.forEach((item, index, arr)=>{
      if(arr[index].value.usersInGroup){
        delete arr[index].value.usersInGroup
      }
    })

    const benchmark = Utils.outputBenchmark(benchmarkStart)

    const jsonResults = JSON.stringify({groupResults:groupResults, secondsElapsed: benchmark} ,null,4)
    Utils.writeFileLine(`${parent.exportsDir}/passwordExpires_ALL_GroupUsers_Results-${parent.OKTA_DOMAIN}-${Utils.getDateString()}.txt`, jsonResults)

    res.send(`<PRE>
${groups.length} groups read in ${benchmark} seconds

${jsonResults}`)
  
  })

  app.get('/expirePasswords_PROD_step2_ReadCsvFindUsersNotInGroups', async (req, res) => {
    
    let benchmarkStart = performance.now()
    
    const passwordIfAfterDateString = '2023-04-25'
    let passwordIfAfterDate = Date.parse(passwordIfAfterDateString)
  
    const outputFilePrefix = `passwordExpire-readAllUsersToCsv-${parent.OKTA_DOMAIN}.okta.com-`

    const everyoneGroupFile = `${parent.exportsDir}/usersInGroup-mytest.okta.com-Group Name Here-00g4dmh46tTVw7fEo297-2023-6-27_20-40-4.csv`

    let everyoneGroupFileCountTotal = 0
    
    const everyoneGroupFileStream = fs.createReadStream(everyoneGroupFile).pipe(
      parse({ delimiter: ",", columns: true }) 
    )

    const stringifierToExpireList = stringify({ header: true, columns: getUserColumns() })

    let usersToExpireCount = 0
    for await (const user of everyoneGroupFileStream ){
      everyoneGroupFileCountTotal++
      
      const passwordChangeDate = Date.parse(user.passwordChanged)
      const userPasswordChangedAfterPolicy = (passwordChangeDate > passwordIfAfterDate)

      if(!userPasswordChangedAfterPolicy && user.status === 'LOCKED_OUT'){ // 'ACTIVE' or 'SUSPENDED' or 'LOCKED_OUT'
        usersToExpireCount++
        //usersToExpire[user.userId] = user
        stringifierToExpireList.write(Object.values(user))
      }
    }

    const outputFile2 = `${outputFilePrefix}-Users-TO-EXPIRE-${Utils.getDateString()}.csv`
    const filepath2 = `${parent.exportsDir}/${outputFile2}`
    const writableStream2 = fs.createWriteStream(filepath2)
    stringifierToExpireList.pipe(writableStream2)
    stringifierToExpireList.on('finish', ()=>{

      const benchmark = Utils.outputBenchmark(benchmarkStart)
      let output = `<PRE>
read ${everyoneGroupFileCountTotal} everyoneGroupFileCountTotal, ${usersToExpireCount} usersToExpireCount
processed in ${benchmark} seconds
To Expire Output saved to <a href="${filepath2}">${outputFile2}</a>`
      res.send(output)
      console.log(output)
    })
    stringifierToExpireList.end()
  
  })

  app.get('/expirePasswords_PROD_step3_ExpireUsersFromCsv', async (req, res) => {
    if(runActive){
      const alreadyRunningError = 'already running, restart node process to restart'
      console.log(alreadyRunningError)
      res.send(alreadyRunningError)
      return
    }
    runActive = true


    const queue = new (await import('p-queue')).default({concurrency: 30})
    
    //list of users to expire - produced from previous steps
    const workFileCsv = `passwordExpire-readAllUsersToCsv-mytest.okta.com--Users-TO-EXPIRE-2023-6-27_21-25-42.csv_EXPIRE-RESULTS-rerun.csv`
        
    //read status file to find where to resume
    //const resultsLogFileName = parent.exportsDir +'/'+'readAllUsersToCsv-mytest.okta.com--Users-TO-EXPIRE-2023-5-4_13-36-3.csv_EXPIRE-RESULTS-2023-5-4_15-25-1.csv'
    const resultsLogFileName = parent.exportsDir +'/'+workFileCsv+'_EXPIRE-RESULTS.csv'

    const benchmarkStart = performance.now()
    
    console.log(`reading resume log ${resultsLogFileName}`)

    //list of users to skip - aka resume from where we left off
    let finishedUserLookup = {}
    let finishedUserCount = 0
    if (!fs.existsSync(resultsLogFileName)) {
      console.log('results file does not exist, creating new')
      Utils.writeFileLine(resultsLogFileName, 'userId,result,errorCode')
    }else{
      const processedInputFileNameParse = fs.createReadStream(resultsLogFileName).pipe( 
        parse({ delimiter: ",", columns: true, relax_column_count: true }) 
      )
      for await (const row of processedInputFileNameParse) {
        finishedUserLookup[row.userId] = true
        finishedUserCount++
      }
    }

    console.log(`Users To Skip From File: ${finishedUserCount}`)

    const fileName = parent.exportsDir +'/'+ workFileCsv
    console.log(`Reading Expire List ${fileName}`)

    const parseResult = fs.createReadStream(fileName).pipe( 
        parse({ delimiter: ",", columns: true }) 
    )

    let workListOfUsersToExpire = []
    let totalRead = 0
    let skippedUsers = 0
    for await (const user of parseResult) {
        totalRead++
        if(finishedUserLookup.hasOwnProperty(user.userId)){
          skippedUsers++
        }else{
          workListOfUsersToExpire.push(user)
        }
    }
    //deallocate resume list
    delete finishedUserLookup

    console.log(`${totalRead} users read`)
    console.log(`${skippedUsers} users skipped`)
    console.log(`${workListOfUsersToExpire.length} users to expire`)
    
    let expireApiCallResults = workListOfUsersToExpire.map(user=>{
      return function(){
        return new Promise(async (resolve, reject)=>{
            try{
                let response = await parent.oktaClient.expirePassword(userId=user.userId)
                //console.log(response)
                const resultTxt = `${user.userId},success`
                console.log(resultTxt)
                Utils.writeFileLine(resultsLogFileName, resultTxt)

                resolve({result: 'success',userId: user.userId})
            }catch(err){
                //console.log(err)
                const resultTxt = `${user.userId},failed,${err?.status} ${err?.errorCode}`
                console.log(resultTxt)
                Utils.writeFileLine(resultsLogFileName, resultTxt)
                
                resolve({result: 'failed',userId: user.userId, error: err})
            }
        })
      }
    })

    queue.addAll(expireApiCallResults).then(()=>{

      const jsonResults = JSON.stringify(expireApiCallResults,null,4)
      Utils.writeFileLine(`${parent.exportsDir}/passwordExpires_ExpireApiCall_Results-${parent.OKTA_DOMAIN}-${Utils.getDateString()}.txt`, jsonResults)
  
      const benchmark = Utils.outputBenchmark(benchmarkStart)
      const logMessage = `${workListOfUsersToExpire.length} users expired in ${benchmark} seconds`
      console.log(logMessage)
      res.send(`<PRE>${logMessage}
  
      ${jsonResults}`)
    })
  
  })

  app.get('/expirePasswords_PROD_step4_ViewFailedUsers', async (req, res) => {
      const benchmarkStart = performance.now()

      const expireResultsFile = parent.exportsDir +'/'+'passwordExpire-readAllUsersToCsv-mytest.okta.com--Users-TO-EXPIRE-2023-6-27_21-25-42.csv_EXPIRE-RESULTS-failureonly.csv'
      
      const resultsLogFileName = parent.exportsDir +'/'+`passwordExpire_${parent.OKTA_DOMAIN}_FAILURE-RESULTS-${Utils.getDateString()}.json`

      console.log(`Reading User List File ${expireResultsFile}`)

      const expireResultsFileReadable = fs.createReadStream(expireResultsFile).pipe( 
          parse({ delimiter: ",", columns: true, relax_column_count: true }) 
      )

      let usersToCheck = []
      for await (const row of expireResultsFileReadable) {
          if(row.result !== 'success'){
            usersToCheck.push(row)
          }
      }

      Utils.outputBenchmark(benchmarkStart)
      console.log(`checking ${usersToCheck.length} users`)

      const queue = new (await import('p-queue')).default({concurrency: 30})

      const columns = [
        "errorCode",
        "userId",
        "firstName",
        "lastName",
        "type id",
        "credential provider type",
        "status",
        "login",
        "created",
        "passwordChanged",
        "activated",
        "lastLogin",
        "statusChanged",
        "SourceType",
        "applicationName",
        "userStatusChangeReason",
      ]
      const csvUsers = stringify({ header: true, columns: columns })

    let userApiCallPromiseArray = usersToCheck.map(user=>{
      return function(){
        return new Promise(async (resolve, reject)=>{
          try{
            let userApiData = await parent.oktaClient.getUser(userId=user.userId)

            csvUsers.write([
              user.errorCode,
              user.userId,
              userApiData.profile.firstName,
              userApiData.profile.lastName,
              userApiData?.type?.id,
              userApiData?.credentials?.provider?.type,
              userApiData.status,
              userApiData.profile.login,
              userApiData.created,
              userApiData.passwordChanged,
              userApiData.activated,
              userApiData.lastLogin,
              userApiData.statusChanged,
              userApiData.profile?.SourceType,
              userApiData.profile?.applicationName,
              userApiData.profile?.userStatusChangeReason,
            ])

            Utils.writeFileLine(resultsLogFileName, JSON.stringify(userApiData,null,4))

            //console.log(response)
            const resultTxt = `${user.userId},success`
            console.log(resultTxt)

            resolve({result: 'success',userId: user.userId})
        }catch(err){
            const resultTxt = `${user.userId},failed,${err?.status} ${err?.errorCode}`
            console.log(resultTxt)
            
            resolve({result: 'failed',userId: user.userId, error: err})
        }
        })
      }
    })

    queue.addAll(userApiCallPromiseArray).then((userApiCallResults)=>{

      const csvUsersOutputFile = `passwordExpire_${parent.OKTA_DOMAIN}_FAILURE-RESULTS-${Utils.getDateString()}.csv`
      const csvUsersFilepath = `${parent.exportsDir}/${csvUsersOutputFile}`
      const csvUsersWritableStream = fs.createWriteStream(csvUsersFilepath)
      csvUsers.pipe(csvUsersWritableStream)
      csvUsers.on('finish', ()=>{

        const jsonResults = JSON.stringify(userApiCallResults,null,4)

        const benchmark = Utils.outputBenchmark(benchmarkStart)
        const logMessage = `${usersToCheck.length} users fetched in ${benchmark} seconds`
        console.log(logMessage)
        res.send(`<PRE>${logMessage}
  
Full Output saved to <a href="${csvUsersFilepath}">${csvUsersOutputFile}</a>

${jsonResults}`)

      })
      csvUsers.end()

    })

  })
  
  app.get('/expirePasswords_PROD_step6_expireAllSuspendedUsers', async (req, res) => {
    if(runActive){
      const alreadyRunningError = 'already running, restart node process to restart'
      console.log(alreadyRunningError)
      res.send(alreadyRunningError)
      return
    }
    runActive = true

    const queue = new (await import('p-queue')).default({concurrency: 30})
    
    //list of SUSPENDED users to expire - produced from previous steps
    //after first run of script re-run failures if they were generic Okta 500 E0000009 error code
    const workFileCsv = `passwordExpire-readAllUsersToCsv-mytest.okta.com--SUSPENDED-Users-TO-EXPIRE-2023-6-28_12-31-13.csv`
    
    //read status file to find where to resume
    const resultsLogFileName = parent.exportsDir +'/'+workFileCsv+'_EXPIRE-RESULTS.csv'
    
    const benchmarkStart = performance.now()

    console.log(`reading resume log ${resultsLogFileName}`)
    
    //list of users to skip - aka resume from where we left off
    let finishedUserLookup = {}
    let finishedUserCount = 0
    if (!fs.existsSync(resultsLogFileName)) {
      console.log('results filt does not exist, creating new')
      Utils.writeFileLine(resultsLogFileName, 'userId,result,errorCode')
    }else{
      const processedInputFileNameParse = fs.createReadStream(resultsLogFileName).pipe( 
        parse({ delimiter: ",", columns: true, relax_column_count: true }) 
      )
      for await (const row of processedInputFileNameParse) {
       finishedUserLookup[row.userId] = true
       finishedUserCount++
      }
    }
    
    console.log(`Users To Skip From File: ${finishedUserCount}`)

    const fileName = parent.exportsDir +'/'+ workFileCsv
    console.log(`Reading Expire List ${fileName}`)

    const parseResult = fs.createReadStream(fileName).pipe( 
        parse({ delimiter: ",", columns: true }) 
    )

    let workListOfUsersToExpire = []
    let totalRead = 0
    let skippedUsers = 0
    for await (const user of parseResult) {
      totalRead++
        if(finishedUserLookup.hasOwnProperty(user.userId)){
          skippedUsers++
        }else{
          workListOfUsersToExpire.push(user)
        }
    }
    //deallocate resume list
    delete finishedUserLookup

    console.log(`${totalRead} users read`)
    console.log(`${skippedUsers} users skipped`)
    console.log(`${workListOfUsersToExpire.length} users to expire`)

    const expireApiCallPromiseArray = workListOfUsersToExpire.map(user=>{
      return function(){
        return new Promise(async (resolve, reject)=>{

          let unsuspendResult = 'unsuspend success'
          try{
            await parent.oktaClient.unsuspendUser(user.userId)
          }catch(err){
            unsuspendResult = `unsuspend failed ${err?.status} ${err?.errorCode}`
            console.log(user.userId, unsuspendResult)
          }
        
          let expireResult = 'expire success'
          try{
            await parent.oktaClient.expirePassword(user.userId)
          }catch(err){
            expireResult = `expire failed ${err?.status} ${err?.errorCode}`
            console.log(user.userId, expireResult)
          }
        
          let resuspendResult = 'resuspend success'
          try{
            await parent.oktaClient.suspendUser(user.userId)
          }catch(err){
            resuspendResult = `resuspend failed ${err?.status} ${err?.errorCode}`
            console.log(user.userId, resuspendResult)
          }

          const resultTxt = `${user.userId},${unsuspendResult},${expireResult},${resuspendResult}`
          Utils.writeFileLine(resultsLogFileName, resultTxt)

          resolve({
            userId: user.userId,
            result: resultTxt
          })

        })
      }
    })

    queue.addAll(expireApiCallPromiseArray).then((expireApiCallResults)=>{

      const jsonResults = JSON.stringify(expireApiCallResults,null,4)
      Utils.writeFileLine(`${parent.exportsDir}/passwordExpires_SUSPEND_ExpireApiCall_Results-${parent.OKTA_DOMAIN}-${Utils.getDateString()}.txt`, jsonResults)
  
      const benchmark = Utils.outputBenchmark(benchmarkStart)
      const logMessage = `${workListOfUsersToExpire.length} users expired in ${benchmark} seconds`
      console.log(logMessage)
      res.send(`<PRE>${logMessage}

      ${jsonResults}`)
    })
  })

app.get('/expirePasswords_PROD_step7_expireAllLockedOutUsers', async (req, res) => {
  if(runActive){
    const alreadyRunningError = 'already running, restart node process to restart'
    console.log(alreadyRunningError)
    res.send(alreadyRunningError)
    return
  }
  runActive = true

  const queue = new (await import('p-queue')).default({concurrency: 30})
  
  //list of LOCKED_OUT users to expire - produced from previous steps
  const workFileCsv = `passwordExpire-readAllUsersToCsv-mytest.okta.com-LOCKED_OUT-Users-TO-EXPIRE-2023-6-28_13-32-4 worklist.csv`
    
  //read status file to find where to resume
  const resultsLogFileName = `${parent.exportsDir}/${workFileCsv}_EXPIRE-RESULTS.csv`
  
  const benchmarkStart = performance.now()

  console.log(`reading resume log ${resultsLogFileName}`)
  
  //list of users to skip - aka resume from where we left off
  let finishedUserLookup = {}
  let finishedUserCount = 0
  if (!fs.existsSync(resultsLogFileName)) {
    console.log('results file does not exist, creating new')
    Utils.writeFileLine(resultsLogFileName, 'userId,result,errorCode')
  }else{
    const processedInputFileNameParse = fs.createReadStream(resultsLogFileName).pipe( 
      parse({ delimiter: ",", columns: true, relax_column_count: true }) 
    )
    for await (const row of processedInputFileNameParse) {
     finishedUserLookup[row.userId] = true
     finishedUserCount++
    }
  }
  
  console.log(`Users To Skip From File: ${finishedUserCount}`)

  const fileName = parent.exportsDir +'/'+ workFileCsv
  console.log(`Reading Expire List ${fileName}`)

  const parseResult = fs.createReadStream(fileName).pipe( 
      parse({ delimiter: ",", columns: true }) 
  )

  let workListOfUsersToExpire = []
  let totalRead = 0
  let skippedUsers = 0
  for await (const user of parseResult) {
    totalRead++
      if(finishedUserLookup.hasOwnProperty(user.userId)){
        skippedUsers++
      }else{
        workListOfUsersToExpire.push(user)
      }
  }
  //deallocate resume list
  delete finishedUserLookup

  console.log(`${totalRead} users read`)
  console.log(`${skippedUsers} users skipped`)
  console.log(`${workListOfUsersToExpire.length} users to expire`)

  const expireApiCallPromiseArray = workListOfUsersToExpire.map(user=>{
    return function(){
      return new Promise(async (resolve)=>{

        let unlockResult = 'unlock success'
        try{
          await parent.oktaClient.unlockUser(user.userId)
        }catch(err){
          unlockResult = `unlock failed ${err?.status} ${err?.errorCode}`
          console.log(user.userId, unlockResult)
        }

        let expireResult = 'expire success'
        try{
          await parent.oktaClient.expirePassword(user.userId)
        }catch(err){
          expireResult = `expire failed ${err?.status} ${err?.errorCode}`
          console.log(user.userId, expireResult)
        }

        const resultTxt = `${user.userId},${unlockResult},${expireResult}`
        Utils.writeFileLine(resultsLogFileName, resultTxt)

        resolve({
          userId: user.userId,
          result: resultTxt
        })

      })
    }
  })

  queue.addAll(expireApiCallPromiseArray).then((expireApiCallResults)=>{

    const jsonResults = JSON.stringify(expireApiCallResults,null,4)
    Utils.writeFileLine(`${parent.exportsDir}/passwordExpires_LOCKED_OUT_ExpireApiCall_Results-${parent.OKTA_DOMAIN}-${Utils.getDateString()}.txt`, jsonResults)

    const benchmark = Utils.outputBenchmark(benchmarkStart)
    const logMessage = `${workListOfUsersToExpire.length} users expired in ${benchmark} seconds`
    console.log(logMessage)
    res.send(`<PRE>${logMessage}

    ${jsonResults}`)
  })
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
    "applicationName"
  ]
}