// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  multimodal,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { normalize } from 'viem/ens';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { v4 as uuidv4 } from 'uuid';
import { generateKeyPair, randomBytes } from 'crypto';
import { promisify } from 'util';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '../.env.local');
dotenv.config({ path: envPath });

// Create Ethereum public client for ENS lookups
const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_URL), // Add ETH_RPC_URL to your .env.local
});

// Add chain mapping
const CHAIN_IDS = {
  'ethereum': '1',
  'base': '8453',
  'polygon': '137',
  'arbitrum': '42161',
  'optimism': '10',
  'avalanche': '43114',
} as const;

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log('waiting for participant');
    const participant = await ctx.waitForParticipant();
    console.log(`starting assistant example agent for ${participant.identity}`);

    const model = new openai.realtime.RealtimeModel({
      instructions: `You are a helpful assistant that helps users look up wallet balances, transaction history, and token prices.

   You will be asked questions on based on the following scenarios: 

      1. When a user asks about wallet balance or transaction history:
         - If they haven't specified a chain, ask which chain they want to check
         - Use confirmEnsName to verify the name/address with the user
         - For transaction history, if they haven't specified a limit, ask how many transactions they want to see (max 100)
         - Wait for their response
      
      2. If they say "no" to the name confirmation:
         - Use spellEnsName to spell out the name letter by letter
         - After spelling it out, ask if that's correct
         - If they say "no", use spellEnsName again
         - If they say "yes", proceed to the next step
      
      3. Only after getting confirmation ("yes"):
         - Use getWalletBalance to fetch the balance
         - Use getTransactionHistory to fetch the transaction history
      
      4. If they ask about token prices:
         - Use getTokenPrice to fetch the current price of the token

      5. When a user wants to create a new wallet:
         - Ask them which blockchain they want to use (options: MATIC-AMOY, SOL-DEVNET, or ETH-SEPOLIA)
         - Ask them which account type they prefer (options: SCA or EOA)
         - Use createCircleWallet with their chosen options to create the wallet
         - Share the new wallet details with them
         - After creating the wallet, ask if they would like to fund it with test tokens
         - If they say yes, use fundWallet with the new wallet's address and blockchain
         - If they say no, let them know they can request funding later

      6. When a user wants to fund an existing wallet:
         - Make sure you have both the wallet address and blockchain network
         - Use fundWallet to request test tokens
         - The supported networks are: MATIC-AMOY, SOL-DEVNET, or ETH-SEPOLIA
         - Share the funding request status with the user
      
      7. If they ask about other information, use the appropriate function to fetch the information
      
  Important: When handling token names:
  - Always confirm the token name spelling with the user before proceeding
  - Example: If user asks for "etherium", confirm if they mean "ethereum"
  - Only proceed with the price check after user confirms`,
      
      voice: 'alloy',
      turnDetection: {
        type: 'server_vad',
        silence_duration_ms: 1000,
        prefix_padding_ms: 100,
        threshold: 0.3
      }
    });

    const fncCtx: llm.FunctionContext = {
      confirmEnsName: {
        description: 'Confirm the ENS name spelling with the user',
        parameters: z.object({
          name: z.string().describe('The name to confirm'),
        }),
        execute: async ({ name }) => {
          // Normalize and append .eth if not present
          const ensName = normalize(name.endsWith('.eth') ? name : `${name}.eth`);
          return `I want to look up the balance for "${ensName}". Is this spelling correct? Please respond with "yes" to proceed or "no" to spell it letter by letter.`;
        },
      },

      spellEnsName: {
        description: 'Spell out ENS name letter by letter to the user',
        parameters: z.object({
          currentAttempt: z.string().describe('The ENS name to spell out'),
        }),
        execute: async ({ currentAttempt }) => {
          const spelled = currentAttempt.split('').join(', ');
          return `Let me spell that out for you: ${spelled}. Is this correct? Please respond with "yes" or "no".`;
        },
      },

      getWalletBalance: {
        description: 'Get the balance of an Ethereum wallet address or ENS name after confirmation',
        parameters: z.object({
          addressOrName: z.string().describe('The confirmed Ethereum address or ENS name to check'),
          chain: z.enum(Object.keys(CHAIN_IDS) as [string, ...string[]]).describe('The blockchain to check'),
        }),
        execute: async ({ addressOrName, chain }) => {
          const chainId = CHAIN_IDS[chain as keyof typeof CHAIN_IDS];
          try {
            // First, try to resolve ENS name if it's not already an address
            let resolvedAddress = addressOrName;
            if (!addressOrName.startsWith('0x')) {
              console.debug(`attempting to resolve ENS name: ${addressOrName}`);
              // Normalize and append .eth if not present
              const ensName = normalize(addressOrName.endsWith('.eth') ? addressOrName : `${addressOrName}.eth`);
              
              const address = await publicClient.getEnsAddress({
                name: ensName,
              });

              if (!address) {
                return `Could not resolve ENS name ${ensName} to an address`;
              }
              
              console.debug(`resolved ${ensName} to ${address}`);
              resolvedAddress = address;
            }

            // Now fetch the balance using 1inch API with ONLY the resolved address
            console.debug(`checking balance for wallet address ${resolvedAddress}`);
            const response = await fetch(
              `https://api.1inch.dev/balance/v1.2/${chainId}/balances/${resolvedAddress}`,
              {
                headers: {
                  'Authorization': `Bearer ${process.env.INCH_API_KEY}`,
                  'Accept': 'application/json',
                }
              }
            );

            if (!response.ok) {
              throw new Error(`1inch API returned status: ${response.status}`);
            }

            const data = await response.json();
            return `The wallet ${addressOrName} (${resolvedAddress}) has the following balances: ${JSON.stringify(data, null, 2)}`;
          } catch (error: unknown) {
            console.error('Error fetching wallet balance:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return `Sorry, I couldn't fetch the balance. Error: ${errorMessage}`;
          }
        },
      },

      getTransactionHistory: {
        description: 'Get transaction history for an Ethereum wallet address or ENS name',
        parameters: z.object({
          addressOrName: z.string().describe('The confirmed Ethereum address or ENS name to check'),
          chain: z.enum(Object.keys(CHAIN_IDS) as [string, ...string[]]).describe('The blockchain to check'),
          limit: z.number().optional().describe('Number of transactions to fetch (max 100)'),
        }),
        execute: async ({ addressOrName, chain, limit }) => {
          const chainId = CHAIN_IDS[chain as keyof typeof CHAIN_IDS];
          try {
            // Resolve ENS name if provided
            let resolvedAddress = addressOrName;
            if (!addressOrName.startsWith('0x')) {
              const ensName = normalize(addressOrName.endsWith('.eth') ? addressOrName : `${addressOrName}.eth`);
              const address = await publicClient.getEnsAddress({
                name: ensName,
              });
              if (!address) {
                return `Could not resolve ENS name ${ensName} to an address`;
              }
              resolvedAddress = address;
            }

            // Use default limit of 10 if not specified
            const queryLimit = limit || 10;
            if (queryLimit > 100) {
              return "Sorry, the maximum limit for transactions is 100. Please specify a lower number.";
            }

            const historyUrl = `https://api.1inch.dev/history/v2.0/history/${resolvedAddress}/events`;

            // Construct URL with query parameters
            const params = new URLSearchParams({
              chainId: chainId,
              limit: queryLimit.toString() // Add limit parameter from user input
            });

            const historyResponse = await fetch(
              `${historyUrl}?${params}`,
              {
                method: 'GET',
                headers: {
                  'Authorization': `Bearer ${process.env.INCH_API_KEY}`,
                  'Accept': 'application/json'
                }
              }
            );

            if (!historyResponse.ok) {
              console.error('Transaction history fetch failed:', {
                status: historyResponse.status,
                statusText: historyResponse.statusText,
                url: historyUrl,
                params: {
                  chainId,
                  limit
                }
              });
              throw new Error(`Transaction history API returned status: ${historyResponse.status}`);
            }

            const historyData = await historyResponse.json();
            console.log('Raw history response:', historyData);

            return `Here are the last ${queryLimit} transactions for ${addressOrName} (${resolvedAddress}): ${JSON.stringify(historyData, null, 2)}`;
          } catch (error: unknown) {
            console.error('Error fetching transaction history:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return `Sorry, I couldn't fetch the transaction history. Error: ${errorMessage}`;
          }
        },
      },

      confirmTokenName: {
        description: 'Confirm the token name spelling with the user',
        parameters: z.object({
          name: z.string().describe('The token name to confirm'),
        }),
        execute: async ({ name }) => {
          console.log('confirmTokenName called:', { name });
          return `I want to look up the price for "${name}". Is this spelling correct? Please respond with "yes" to proceed or "no" to spell it differently.`;
        },
      },

      getTokenPrice: {
        description: 'Get the current price of a token by searching its name and checking spot price',
        parameters: z.object({
          tokenName: z.string().describe('The confirmed token name to search for'),
          chain: z.enum(Object.keys(CHAIN_IDS) as [string, ...string[]]).describe('The blockchain to check'),
        }),
        execute: async ({ tokenName, chain }) => {
          console.log('getTokenPrice called:', { tokenName, chain });
          const chainId = CHAIN_IDS[chain as keyof typeof CHAIN_IDS];
          try {
            // Search for token using the Token API with query parameters
            const searchUrl = `https://api.1inch.dev/token/v1.2/${chainId}/search`;
            const searchParams = new URLSearchParams({
              query: tokenName,
              only_positive_rating: 'true'
            });
            
            // Log the raw request details
            console.log('Token search request:', {
              url: searchUrl,
              params: searchParams.toString(),
              headers: {
                'Authorization': 'Bearer <REDACTED>',
                'Accept': 'application/json',
              }
            });
            
            const searchResponse = await fetch(
              `${searchUrl}?${new URLSearchParams(searchParams)}`,
              {
                headers: {
                  'Authorization': `Bearer ${process.env.INCH_API_KEY}`,
                  'Accept': 'application/json',
                }
              }
            );

            if (!searchResponse.ok) {
              console.error('Token search failed:', { 
                status: searchResponse.status,
                statusText: searchResponse.statusText,
                url: searchUrl,
                params: searchParams
              });
              throw new Error(`Token search API returned status: ${searchResponse.status}`);
            }

            const searchData = await searchResponse.json();
            console.log('Raw search response:', searchData);

            if (!Array.isArray(searchData) || searchData.length === 0) {
              console.log('No tokens found for query:', tokenName);
              return `Sorry, I couldn't find a token matching "${tokenName}" on ${chain}`;
            }

            // Get the first token from the search results
            const token = searchData[0];
            console.log('Selected token for price check:', {
              symbol: token.symbol,
              name: token.name,
              address: token.address,
              chain: chain
            });

            // Get spot price using ONLY the token address from the search response
            const priceUrl = `https://api.1inch.dev/price/v1.1/${chainId}`;
            
            const priceResponse = await fetch(
              priceUrl,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${process.env.INCH_API_KEY}`,
                  'Accept': 'application/json',
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  tokens: [token.address],
                  currency: "USD"
                })
              }
            );

            if (!priceResponse.ok) {
              console.error('Price fetch failed:', {
                status: priceResponse.status,
                statusText: priceResponse.statusText,
                url: priceUrl,
                body: {
                  tokens: [token.address],
                  currency: "USD"
                }
              });
              throw new Error(`Spot price API returned status: ${priceResponse.status}`);
            }

            const priceData = await priceResponse.json();
            console.log('Raw price response:', priceData);

            // The response format is { "tokenAddress": "priceInUSD" }
            const price = priceData[token.address];
            console.log('Price data received:', { 
              tokenAddress: token.address,
              price: price 
            });

            return `${token.name} (${token.symbol}) on ${chain} is currently worth $${price} USD`;
          } catch (error: unknown) {
            console.error('Error in getTokenPrice:', {
              error: error instanceof Error ? error.message : 'Unknown error',
              tokenName,
              chain,
              chainId,
              stack: error instanceof Error ? error.stack : undefined
            });
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return `Sorry, I couldn't fetch the token price. Error: ${errorMessage}`;
          }
        },
      },

      createCircleWallet: {
        description: 'Create a new Circle wallet for the user',
        parameters: z.object({
          blockchain: z.enum(['MATIC-AMOY', 'SOL-DEVNET', 'ETH-SEPOLIA']).describe('The blockchain network for the wallet'),
          accountType: z.enum(['SCA', 'EOA']).describe('The type of account to create'),
        }),
        execute: async ({ blockchain, accountType }) => {
          try {
            const client = initiateDeveloperControlledWalletsClient({
              apiKey: 'TEST_API_KEY:93dd4d5865d2c49be6acef5259c1866e:82972958035a307d9b42906e763e331a',
              entitySecret: '9be810e30c3e952193e924f6b1888b9123b49dfccc328df5d66d844c7cb0e64d'
          });


            // const client = initiateDeveloperControlledWalletsClient({
            //   apiKey: process.env.CIRCLE_API_KEY!,
            //   entitySecret: process.env.ENTITY_SECRET!
            // });

            // const response = await client.createWalletSet({
            //   name: 'sayless1'
            // });

            // const walletSetId = response.data?.walletSet.id;
            // if (!walletSetId) {
            //   throw new Error('Failed to create wallet set: missing wallet set ID');
            // }

        

          const walletResponse = await client.createWallets({
            accountType: 'EOA',
            blockchains: ['ETH-SEPOLIA'],
            walletSetId: 'f379a57e-6ebe-5945-a5f0-0633133fea8d',
            count: 1
        });
        console.log(walletResponse.data?.wallets[0].address)


            return `Successfully created a new ${accountType} wallet on ${blockchain}:
              Address: ${walletResponse.data?.wallets[0].address}
              Blockchain: ${walletResponse.data?.wallets[0].blockchain}`;

          } catch (error) {
            console.error('Error in createCircleWallet:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return `Failed to create wallet: ${errorMessage}`;
          }
        },
      },

      fundWallet: {
        description: 'Request test tokens for a newly created wallet',
        parameters: z.object({
          address: z.string().describe('The wallet address to fund'),
          blockchain: z.enum(['MATIC-AMOY', 'SOL-DEVNET', 'ETH-SEPOLIA']).describe('The blockchain network of the wallet'),
        }),
        execute: async ({ address, blockchain }) => {
          try {
            const url = 'https://api.circle.com/v1/faucet/drips';
            const options = {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.CIRCLE_API_KEY}`
              },
              body: JSON.stringify({
                destinationAddress: address,
                blockchain: blockchain
              })
            };

            const response = await fetch(url, options);
            const data = await response.json();

            if (response.ok) {
              return `Successfully requested test tokens for your wallet:
                Status: ${data.status}
                Destination Address: ${address}
                Blockchain: ${blockchain}`;
            } else {
              throw new Error(`API request failed: ${data.message || 'Unknown error'}`);
            }
          } catch (error) {
            console.error('Error in fundWallet:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return `Failed to fund wallet: ${errorMessage}`;
          }
        },
      },
    };
    const agent = new multimodal.MultimodalAgent({ model, fncCtx });
    
    // Create a new session and ensure it's properly typed
    const session = await agent
      .start(ctx.room, participant)
      .then((session) => session as openai.realtime.RealtimeSession);

    // Initialize the conversation with a greeting first
    session.conversation.item.create(llm.ChatMessage.create({
      role: llm.ChatRole.ASSISTANT,
      text: 'How can I help you today?'
    }));

    // Create a new response without any truncation attempts
    const response = session.response.create();

    // Handle cleanup when participant disconnects
    ctx.room.on('participantDisconnected', async () => {
      await session.close();
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
