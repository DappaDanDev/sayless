import { z } from "zod";

import { tool } from "@langchain/core/tools";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import dotenv from 'dotenv';
import { normalize } from 'viem/ens';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';



dotenv.config();

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



const add = tool(
  async ({ a, b }) => {
    return a + b;
  },
  {
    name: "add",
    description:
      "Add two numbers. Please let the user know that you're adding the numbers BEFORE you call the tool",
    schema: z.object({
      a: z.number(),
      b: z.number(),
    }),
  }
);

const tavilyTool = new TavilySearchResults({
  maxResults: 5,
  kwargs: {
    includeAnswer: true,
  },
});

tavilyTool.description = `This is a search tool for accessing the internet.\n\nLet the user know you're asking your friend Tavily for help before you call the tool.`;


const confirmEnsName = tool(
  async ({ name }) => {
    // Normalize and append .eth if not present
    const ensName = normalize(name.endsWith('.eth') ? name : `${name}.eth`);
    return `I want to look up the balance for "${ensName}". Is this spelling correct? Please respond with "yes" to proceed or "no" to spell it letter by letter.`;
  },
  {
    name: "confirmEnsName",
    description: "Confirm the ENS name spelling with the user. Use this before proceeding with any ENS-related operations.",
    schema: z.object({
      name: z.string().describe('The ENS name to confirm'),
    }),
  }
);








const createCircleWallet = tool(
  async ({ blockchain, accountType }) => {
    try {
      const client = initiateDeveloperControlledWalletsClient({
        apiKey: 'TEST_API_KEY:93dd4d5865d2c49be6acef5259c1866e:82972958035a307d9b42906e763e331a',
        entitySecret: '9be810e30c3e952193e924f6b1888b9123b49dfccc328df5d66d844c7cb0e64d'
      });

      const walletResponse = await client.createWallets({
        accountType: accountType,
        blockchains: [blockchain],
        walletSetId: 'f379a57e-6ebe-5945-a5f0-0633133fea8d',
        count: 1
      });

      if (!walletResponse.data?.wallets[0]) {
        throw new Error('Failed to create wallet: No wallet data returned');
      }

      return `Successfully created a new ${accountType} wallet on ${blockchain}:
        Address: ${walletResponse.data.wallets[0].address}
        Blockchain: ${walletResponse.data.wallets[0].blockchain}`;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to create wallet: ${errorMessage}`);
    }
  },
  {
    name: "createCircleWallet",
    description: "Creates a new Circle wallet for the user. Before using this tool, confirm the blockchain network (MATIC-AMOY, SOL-DEVNET, or ETH-SEPOLIA) and account type (SCA or EOA) with the user.",
    schema: z.object({
      blockchain: z.enum(['MATIC-AMOY', 'SOL-DEVNET', 'ETH-SEPOLIA'])
        .describe('The blockchain network for the wallet'),
      accountType: z.enum(['SCA', 'EOA'])
        .describe('The type of account to create (SCA = Smart Contract Account, EOA = Externally Owned Account)'),
    }),
  }
);

const fundWallet = tool(
  async ({ address, blockchain }) => {
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to fund wallet: ${errorMessage}`);
    }
  },
  {
    name: "fundWallet",
    description: "Request test tokens for a wallet. Before using this tool, confirm the wallet address and blockchain network (MATIC-AMOY, SOL-DEVNET, or ETH-SEPOLIA).",
    schema: z.object({
      address: z.string()
        .describe('The wallet address to fund'),
      blockchain: z.enum(['MATIC-AMOY', 'SOL-DEVNET', 'ETH-SEPOLIA'])
        .describe('The blockchain network of the wallet'),
    }),
  }
);

const spellEnsName = tool(
  async ({ currentAttempt }) => {
    const spelled = currentAttempt.split('').join(', ');
    return `Let me spell that out for you: ${spelled}. Is this correct? Please respond with "yes" or "no".`;
  },
  {
    name: "spellEnsName",
    description: "Spell out ENS name letter by letter to the user when they need clarification on the spelling",
    schema: z.object({
      currentAttempt: z.string().describe('The ENS name to spell out'),
    }),
  }
);

const getWalletBalance = tool(
  async ({ addressOrName, chain }) => {
    const chainId = CHAIN_IDS[chain as keyof typeof CHAIN_IDS];
    try {
      // First, try to resolve ENS name if it's not already an address
      let resolvedAddress = addressOrName;
      if (!addressOrName.startsWith('0x')) {
        console.debug(`attempting to resolve ENS name: ${addressOrName}`);
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

      // Fetch balance using 1inch API
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
  {
    name: "getWalletBalance",
    description: "Get the balance of an Ethereum wallet address or ENS name after confirmation",
    schema: z.object({
      addressOrName: z.string().describe('The confirmed Ethereum address or ENS name to check'),
      chain: z.enum(Object.keys(CHAIN_IDS) as [string, ...string[]]).describe('The blockchain to check'),
    }),
  }
);

const getTransactionHistory = tool(
  async ({ addressOrName, chain, limit }) => {
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
        limit: queryLimit.toString()
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
  {
    name: "getTransactionHistory",
    description: "Get transaction history for an Ethereum wallet address or ENS name",
    schema: z.object({
      addressOrName: z.string().describe('The confirmed Ethereum address or ENS name to check'),
      chain: z.enum(Object.keys(CHAIN_IDS) as [string, ...string[]]).describe('The blockchain to check'),
      limit: z.number().optional().describe('Number of transactions to fetch (max 100)'),
    }),
  }
);

const deployContract = tool(
  async ({ name, symbol, totalSupply }) => {
    try {
      const url = 'https://gwysygyxpvc7dat55so4q7miaa.multibaas.com/api/v0/contracts/erc20/deploy';
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.CURVE_GRID_KEY}`
        },
        body: JSON.stringify({
          from: "0x24bF6580ED276b6ff33269DD361eE00FE3a2c912",
          signer: "0x24bF6580ED276b6ff33269DD361eE00FE3a2c912",
          args: [name, symbol, totalSupply]
        })
      };

      console.log('Request body:', options.body);

      const response = await fetch(url, options);
      const data = await response.json();
      console.log('Raw API Response:', data);

      return `Contract deployment initiated. Check the console for deployment details.`;
    } catch (error) {
      console.error('Error in deployContract:', error);
      return `Failed to deploy contract. Check console for details.`;
    }
  },
  {
    name: "deployContract",
    description: "Deploy an ERC20 token contract with specified parameters",
    schema: z.object({
      name: z.string().describe('The name of the token'),
      symbol: z.string().describe('The symbol of the token'),
      totalSupply: z.string().describe('The total supply of the token'),
    }),
  }
);

export const TOOLS = [add, tavilyTool, createCircleWallet, fundWallet, confirmEnsName, spellEnsName, getWalletBalance, getTransactionHistory, deployContract];
