import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import dotenv from 'dotenv';
dotenv.config();

const client = initiateDeveloperControlledWalletsClient({
    apiKey: 'TEST_API_KEY:93dd4d5865d2c49be6acef5259c1866e:82972958035a307d9b42906e763e331a',
    entitySecret: '9be810e30c3e952193e924f6b1888b9123b49dfccc328df5d66d844c7cb0e64d'
});

const response = await client.createWalletSet({
    name: 'sayless1'
});

console.log(response)

const response2 = await client.createWallets({
    name: 'sayless1',
    accountType: 'SCA',
    blockchains: ['MATIC-AMOY'],
    walletSetId: response.data.walletSet.id,
    count: 1
});

console.log(response2)