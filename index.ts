import { ethers } from "ethers";
import { Block } from "ethers"; // Explicitly import Block type if needed later, provider methods often return it

// --- Configuration ---
// IMPORTANT: Replace with your actual BSC RPC URL (consider using environment variables for security)
const BSC_RPC_URL = process.env.BSC_RPC_URL || "YOUR_BSC_RPC_URL";
const TARGET_SPENDER_ADDRESS = ethers.getAddress("0xb300000b72deaeb607a12d5f54773d1c19c7028d"); // Use getAddress for checksum validation
const APPROVE_FUNC_SIGNATURE = "approve(address,uint256)";
const APPROVE_FUNC_SELECTOR = ethers.id(APPROVE_FUNC_SIGNATURE).substring(0, 10); // Calculates "0x095ea7b3"

// How many recent blocks to scan (adjust as needed)
const BLOCKS_TO_SCAN = 100;
const BATCH_SIZE = 10; // Process blocks in batches for efficiency

// Standard BEP-20 ABI (minimal, only need 'name' function)
const BEP20_ABI = [
  "function name() public view returns (string)",
  "function symbol() public view returns (string)", // Optional: for symbol
  "function decimals() public view returns (uint8)", // Optional: for decimals
  // Include approve signature for creating the Interface
  "function approve(address _spender, uint256 _value) public returns (bool success)",
];

// Interface for decoding transaction data
const approveInterface = new ethers.Interface(BEP20_ABI);

// --- Script Logic ---

async function scanRecentApprovals() {
  const foundTokens = new Set<string>(); // Use a set for unique token addresses

  console.log("Connecting to BSC node...");
  let provider: ethers.JsonRpcProvider;
  try {
    // Using JsonRpcProvider for explicit JSON-RPC connection
    provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
    // Perform a quick check to ensure connection is valid
    const network = await provider.getNetwork();
    console.log(`Connected to network: ${network.name} (Chain ID: ${network.chainId})`);
  } catch (error) {
    console.error(`Error connecting to BSC node at ${BSC_RPC_URL}:`, error);
    return;
  }

  try {
    const latestBlockNumber = await provider.getBlockNumber();
    const startBlock = Math.max(0, latestBlockNumber - BLOCKS_TO_SCAN + 1); // Ensure start_block isn't negative

    console.log(`Scanning blocks from ${startBlock} to ${latestBlockNumber}...`);

    for (let currentBlock = startBlock; currentBlock <= latestBlockNumber; currentBlock += BATCH_SIZE) {
      const endBatchBlock = Math.min(currentBlock + BATCH_SIZE - 1, latestBlockNumber);
      console.log(`Fetching blocks ${currentBlock} to ${endBatchBlock}...`);

      const blockPromises: Promise<Block | null>[] = [];
      for (let blockNum = currentBlock; blockNum <= endBatchBlock; blockNum++) {
        // Fetch block with transactions concurrently within the batch
        // Using getBlock(num, true) directly fetches transactions
        blockPromises.push(provider.getBlock(blockNum, true));
      }

      const blocks = await Promise.all(blockPromises);

      console.log(`Processing ${blocks.length} blocks...`);
      for (const block of blocks) {
        if (!block || !block.prefetchedTransactions || block.prefetchedTransactions.length === 0) {
          continue; // Skip empty blocks or blocks where tx fetching failed
        }

        // Access prefetched transactions
        for (const tx of block.prefetchedTransactions) {
          // Check if it's a contract interaction, has data, and matches the selector
          if (tx.to && tx.data && tx.data.startsWith(APPROVE_FUNC_SELECTOR)) {
            try {
              // Decode the input data using the interface
              const decodedData = approveInterface.parseTransaction({ data: tx.data });

              // Check if the function name is indeed 'approve' (sanity check)
              // and if the first argument (spender) matches our target
              if (decodedData && decodedData.name === "approve") {
                const spender = decodedData.args[0] as string; // First argument is spender
                const tokenAddress = ethers.getAddress(tx.to); // Ensure checksummed address

                // Compare spender addresses (case-insensitive comparison done by getAddress normalization)
                if (ethers.getAddress(spender) === TARGET_SPENDER_ADDRESS) {
                  if (!foundTokens.has(tokenAddress)) {
                    console.log(`  Found approval in block ${block.number}:`);
                    console.log(`    Tx Hash: ${tx.hash}`);
                    console.log(`    Token Contract: ${tokenAddress}`);
                    foundTokens.add(tokenAddress);
                  }
                }
              }
            } catch (decodeError) {
              // Ignore transactions where data doesn't match the expected format
              console.warn(`  Could not decode transaction data for ${tx.hash}: ${decodeError}`);
            }
          }
        }
      }
      // Optional: Small delay between batches if hitting rate limits
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // --- Get Token Names ---
    if (foundTokens.size === 0) {
      console.log("\nNo approval transactions found for the target spender in the scanned blocks.");
      return;
    }

    console.log(`\nFound ${foundTokens.size} unique potential token contract(s). Fetching names...`);

    const results: { address: string; name: string }[] = [];
    for (const tokenAddr of foundTokens) {
      try {
        const contract = new ethers.Contract(tokenAddr, BEP20_ABI, provider);
        const tokenName = await contract.name();
        console.log(`  - Token Address: ${tokenAddr}, Name: ${tokenName}`);
        results.push({ address: tokenAddr, name: tokenName });
      } catch (e: any) {
        console.log(`  - Token Address: ${tokenAddr}, Name: <Could not fetch name - Error: ${e?.message ?? e}>`);
        results.push({ address: tokenAddr, name: "<Error fetching name>" });
      }
    }

    console.log("\nScan complete.");
    // You can further process the 'results' array here
  } catch (error) {
    console.error("\nAn unexpected error occurred during scanning:", error);
  } finally {
    // Clean up the provider connection if necessary (though usually not required for script termination)
    // provider.destroy(); // If using WebSocketProvider, you might need this. Less critical for HTTP.
    console.log("Provider cleanup (if applicable).");
  }
}

// --- Run the scan ---
if (!BSC_RPC_URL || BSC_RPC_URL === "YOUR_BSC_RPC_URL") {
  console.error("Error: BSC_RPC_URL is not configured.");
  console.error("Please replace 'YOUR_BSC_RPC_URL' in the script or set the BSC_RPC_URL environment variable.");
} else {
  scanRecentApprovals().catch((err) => {
    console.error("Script execution failed:", err);
    process.exit(1);
  });
}
