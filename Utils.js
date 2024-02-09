const fs = require("fs")
const { parse } = require("csv")

module.exports = {
    
    cleanupUtfString:function(input){
      const utf8start = `\u{100}`
      const utf8end = `\u{10FFF0}`
      const utf8searchPattern = new RegExp(`[${utf8start}-${utf8end}]`,`g`)

      input = input.replace(utf8searchPattern, ' ')
      input = input.replace(/\s+/g,' ')
      return input
    },
    readCsvFileToArray:async function(inputFileName){
      const parseResult = fs.createReadStream(inputFileName).pipe( 
        parse({ delimiter: ",", columns: true, relax_column_count: true, bom: true }) 
      );
    
      let outputArr = [];
      for await (const record of parseResult) {
        outputArr.push(record);
      }

      return outputArr;
    },

    writeStreamToFile:function(stream,filepath){
      return new Promise((resolve, reject) => {
        const writableStream = fs.createWriteStream(filepath)
        stream.pipe(writableStream)
        stream.on('finish', ()=>{
          resolve()
        })
        stream.end()
      })
    },

    sortArrayCaseInsensitive:function(arr){
        return arr.sort(function (a, b) {
            return a.toLowerCase().localeCompare(b.toLowerCase())
        })
    },
    //promisify the bulk data collection process
    getCollectionData:function(collection){
      
      return new Promise((resolve, reject) => {
          let combinedData = [];
          collection.each(item => {
            //dump 1 record for debugging?
            // console.log(item)
            // throw new Error("asplode pls")
            combinedData.push(item)
          }).then(function(){
            resolve(combinedData)
          }).catch(err => {
            err.combinedData = combinedData;
            reject(err);
          });
      })
    
    },
    //promisify the bulk data collection process
    getCollectionDataProcessor:function(collection, processor){
      
      return new Promise((resolve, reject) => {
          let combinedData = [];
          collection.each(item => {
            combinedData.push(processor(item))
          }).then(function(){
            resolve(combinedData)
          }).catch(err => {
            err.combinedData = combinedData;
            reject(err);
          });
      })
    
    },
    
    replaceInvalidFileNameChars:function(name){
      return name.replace(/([^a-z0-9 ]+)/gi, '_')
    },

    getDateString:function(){
      const now = new Date();
      return now.getFullYear() + '-' + (now.getMonth()+1) + '-' + now.getDate() + '_' + now.getHours() + '-' + now.getMinutes() + '-' + now.getSeconds()
    },
    formatDateYmd:function(input){
      if(!(input instanceof Date)){
        input = new Date(parseInt(input))
      }
      return input.getFullYear() + '-' + (input.getMonth()+1) + '-' + input.getDate() 
    },
    
    outputBenchmark:function(startTime){
      //calculate
      let resultTime = (performance.now() - startTime) / 1000; //seconds
    
      //round
      resultTime = this.roundTime2(resultTime);
    
      console.log(`BENCHMARK! ${resultTime} seconds elapsed`)
      return resultTime;
    },

    roundTime2:function(inputNumber){
      return Math.round((inputNumber + Number.EPSILON) * 100) / 100;
    },
    
  writeFileLine:function(fileName, logLine){
    fs.writeFileSync(fileName, logLine+'\r\n', {flag:'a'})
  },

  sleep: function(waitTimeInMs){
      return new Promise(resolve => setTimeout(resolve, waitTimeInMs))
  },

  maskEmail: function(email){
    let split = email.split('@')
    if( split.length < 2 ){
      return email
    }
    return new Array(split[0].length).fill('x').join('') + "@" + split[1]
  },

  maskUserId:function(userId){
    if(userId===null){
      return null
    }
    if(userId===''){
      return ''
    }
    return 'xxxxxxxxxx'+userId.slice(10)

  },

  trimDateTimeToDate: function(datetime){
    if(datetime===null){
      return null
    }
    if(datetime===''){
      return ''
    }
    return datetime.slice(0,10)
  }

}