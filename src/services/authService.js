const { Auth } = require('msmc');

async function authenticateMicrosoft() {
    const authManager = new Auth("select_account");
    const xboxManager = await authManager.launch("electron");
    const token = await xboxManager.getMinecraft();
    
    return {
        accessToken: token.mclc().access_token,
        clientToken: token.mclc().client_token,
        uuid: token.mclc().uuid,
        name: token.mclc().name,
        userType: token.mclc().user_type
    };
}

module.exports = { authenticateMicrosoft };
