# Cumulant — contract build / test / deploy
# Loads ../.env so DEPLOYER_PRIVATE_KEY, USDC_ADDRESS, ARC_TESTNET_RPC_URL are available.
include ../.env
export

.PHONY: build test fmt anvil deploy-local deploy-arc seed-note-arc

build:
	forge build

test:
	forge test -vv

fmt:
	forge fmt

anvil:
	anvil --chain-id 31337

# Local end-to-end: deploys a MockUSDC, the protocol, and demo seed data.
# Uses Anvil account #0 as deployer/owner/resolver so it matches the backend's local resolver key.
ANVIL_PK := 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
deploy-local:
	DEPLOYER_PRIVATE_KEY=$(ANVIL_PK) DEPLOY_MOCK_USDC=true SEED_DEMO=true \
	forge script script/Deploy.s.sol:Deploy --rpc-url anvil --broadcast

# LIVE Arc testnet deploy against canonical USDC (0x3600…0000). Seeds markets/basket/tranche.
# Requires DEPLOYER_PRIVATE_KEY funded with USDC (gas + collateral) via faucet.circle.com.
# The protected note is seeded separately (seed-note-arc) because Arc's USDC transferFrom routes
# through a native blocklist precompile that forge's local script EVM can't execute.
deploy-arc:
	SEED_DEMO=true \
	forge script script/Deploy.s.sol:Deploy --rpc-url arc_testnet --broadcast --slow
	$(MAKE) seed-note-arc

# Create the demo protected note on Arc via cast (broadcasts against the real node).
seed-note-arc:
	$(eval PN := $(shell python3 -c "import json;print(json.load(open('deployments/5042002.json'))['protectedNote'])"))
	cast send $(USDC_ADDRESS) 'approve(address,uint256)' $(PN) 5000000 \
		--rpc-url $(ARC_TESTNET_RPC_URL) --private-key $(DEPLOYER_PRIVATE_KEY)
	cast send $(PN) 'createNote(string,uint256,uint8,uint256)' "ETH Upside Protected Note" 0 1 5000000 \
		--rpc-url $(ARC_TESTNET_RPC_URL) --private-key $(DEPLOYER_PRIVATE_KEY)
