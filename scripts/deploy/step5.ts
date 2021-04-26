import {
  Deployment,
  validAddress,
  deploy,
  getContractFromDeployment,
} from "../helpers/deployHelpers";

export async function step5(
  deployer: any,
  hre: any,
  deployment: Deployment,
  consts: any
) {
  const pendleRouterAddress = deployment.contracts.PendleRouter.address;
  const pendleDataAddress = deployment.contracts.PendleData.address;

  if (!validAddress("PendleRouter address", pendleRouterAddress))
    process.exit(1);
  if (!validAddress("PendleData address", pendleDataAddress)) process.exit(1);

  const pendleData = await getContractFromDeployment(
    hre,
    deployment,
    "PendleData"
  );
  await pendleData.initialize(pendleRouterAddress);

  await pendleData.setLockParams(
    consts.misc.LOCK_NUMERATOR,
    consts.misc.LOCK_DENOMINATOR
  );
  console.log(`\t\tSet lock parameters for markets`);

  console.log(`\tPendleRouter address used = ${pendleRouterAddress}`);
  console.log(`\tPendleData address used = ${pendleDataAddress}`);
}