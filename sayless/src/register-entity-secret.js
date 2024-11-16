import { 
    generateEntitySecret,
    generateEntitySecretCiphertext ,
    registerEntitySecretCiphertext,
    initiateDeveloperControlledWalletsClient 
  } from '@circle-fin/developer-controlled-wallets';
  import { mkdir } from 'fs/promises';
  import { dirname } from 'path';
  import { fileURLToPath } from 'url';
  import dotenv from 'dotenv';
  import forge from 'node-forge';

// ... imports reain unchanged ...

async function main() {
  // Generate entity secret using crypto instead of generateEntitySecret
  const entitySecret = crypto.randomBytes(32).toString('hex');

  generateEntitySecretCiphertext(entitySecret)
  
  console.log('Generated entity secret:', entitySecret);


  // Import and configure the developer-controlled wallet SDK
const circleDeveloperSdk = initiateDeveloperControlledWalletsClient({
  apiKey: 'TEST_API_KEY:be6d10e2e7b0e856c42a6c8b1c5a4294:385f920d52cb5e4e007daff1a117a5df',
  entitySecret: entitySecret // Make sure to enter the entity secret from the step above.
});

const response = await circleDeveloperSdk.getPublicKey({});

console.log(response)
  
}

main().catch(console.error);