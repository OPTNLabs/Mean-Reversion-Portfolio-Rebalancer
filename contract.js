// contract.js
import { Contract, ElectrumNetworkProvider } from "cashscript";
import { compileFile } from "cashc";
import { NETWORK, MIN_TOTAL_SATS } from "./config.js";

export function getProviderAndContract() {
  const provider = new ElectrumNetworkProvider(NETWORK);

  const artifact = compileFile(
    new URL("./contracts/SumInputs.cash", import.meta.url)
  );

  const contract = new Contract(artifact, [MIN_TOTAL_SATS], { provider });

  console.log("SumInputs contract address:", contract.address);
  console.log("SumInputs token address  :", contract.tokenAddress);
  console.log("Contract bytesize        :", contract.bytesize);
  console.log("Contract opcount         :", contract.opcount);

  return { provider, contract };
}
