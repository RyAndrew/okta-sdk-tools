const Utils = require("./Utils")
const { stringify } = require("csv")
const fs = require("fs")

module.exports = {
    getGroupIdFromName: async function(parent, groupName){
        
        let groupsCollection = await parent.oktaClient.groupApi.listGroups({search:`profile.name eq "${groupName}"`})

        let allGroups = await Utils.getCollectionData(groupsCollection)

        if(allGroups.length < 1){
            return null
        }
        
        return allGroups[0].id;
    },
    writeUserCollectionToCsv: async function(parent, collection, fileName){

        const usersInGroup = await Utils.getCollectionData(collection)

        const columns = [
            "userId",
            "status",
            //"login",
            "passwordChanged",
            "activated",
            "statusChanged",
        ]
        const stringifier = stringify({ header: true, columns: columns })
    
        usersInGroup.forEach(user => {
            stringifier.write([
                user.id,
                user.status,
                //user.profile.login,
                user.passwordChanged,
                user.activated,
                user.statusChanged,
            ])
        })
    
        const filepath = `${parent.exportsDir}/${fileName}`
        const writableStream = fs.createWriteStream(filepath)
    
        return new Promise((resolve) => {
            stringifier.pipe(writableStream)
            stringifier.on('finish', ()=>{
                resolve({
                    result: 'success',
                    userLength: usersInGroup.length,
                    users: usersInGroup
                })
            })
            stringifier.end()
        })
        
    },
    writeGroupUsersToCsv: async function(parent, groupName, groupId ){
        let usersInGroup
    
        let usersInGroupCollection = await parent.oktaClient.groupApi.listGroupUsers({groupId:groupId})
    
        const columns = [
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
        ]
        const stringifier = stringify({ header: true, columns: columns })
        
        usersInGroupCount = 0
        await Utils.getCollectionDataProcessor(usersInGroupCollection, user => {
            
            usersInGroupCount++

            stringifier.write([
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
            ])
            return ''
        })
    
        const filename = `usersInGroup-${parent.OKTA_DOMAIN}-${Utils.replaceInvalidFileNameChars(groupName)}-${groupId}-${Utils.getDateString()}.csv`
        const filepath = `${parent.exportsDir}/${filename}`
        const writableStream = fs.createWriteStream(filepath)
    
        return new Promise((resolve, reject) => {
            stringifier.pipe(writableStream)
            stringifier.on('finish', ()=>{
                resolve({
                    groupName: groupName, 
                    groupId: groupId,
                    result: 'success',
                    groupCsvFile:filename,
                    usersInGroupLength: usersInGroupCount,
                    usersInGroup: usersInGroup
                })
            })
            stringifier.end()
        })
    
    }
}