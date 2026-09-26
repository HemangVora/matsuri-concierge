import { expect } from 'chai';
import { network } from 'hardhat';

const { ethers } = await network.create();

const types = {
  Share: [
    { name: 'billId', type: 'bytes32' },
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

async function deploy() {
  const [owner, friend, organizer, attacker] = await ethers.getSigners();
  const coin = await (await ethers.getContractFactory('MatsuriStablecoin')).deploy('Matsuri Yen', 'MJPY', owner.address);
  const settlement = await (await ethers.getContractFactory('KanjoSettlement')).deploy(await coin.getAddress());
  const amount = ethers.parseUnits('1100', 18);
  await coin.mint(friend.address, amount * 3n);
  await coin.connect(friend).approve(await settlement.getAddress(), amount * 3n);
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: 'KanjoSettlement', version: '1', chainId, verifyingContract: await settlement.getAddress() };
  const billId = ethers.id('bill-1');
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const share = { billId, from: friend.address, to: organizer.address, amount, deadline };
  const signature = await friend.signTypedData(domain, types, share);
  return { friend, organizer, attacker, coin, settlement, share, signature, domain };
}

describe('KanjoSettlement', () => {
  it('moves the signed share to the signed recipient', async () => {
    const { organizer, coin, settlement, share, signature } = await deploy();
    await expect(
      settlement.connect(organizer).settle(share.billId, share.from, share.to, share.amount, share.deadline, signature)
    ).to.emit(settlement, 'ShareSettled').withArgs(share.billId, share.from, share.to, share.amount);
    expect(await coin.balanceOf(organizer.address)).to.equal(share.amount);
  });

  it('rejects a replay of the same share', async () => {
    const { settlement, share, signature } = await deploy();
    await settlement.settle(share.billId, share.from, share.to, share.amount, share.deadline, signature);
    await expect(
      settlement.settle(share.billId, share.from, share.to, share.amount, share.deadline, signature)
    ).to.be.revertedWith('Already settled');
  });

  it('rejects a recipient the payer did not sign', async () => {
    const { attacker, settlement, share, signature } = await deploy();
    await expect(
      settlement.connect(attacker).settle(share.billId, share.from, attacker.address, share.amount, share.deadline, signature)
    ).to.be.revertedWith('Bad signature');
  });

  it('rejects an expired share', async () => {
    const { friend, organizer, settlement, domain } = await deploy();
    const share = { billId: ethers.id('bill-2'), from: friend.address, to: organizer.address, amount: 1n, deadline: 1n };
    const sig = await friend.signTypedData(domain, types, share);
    await expect(
      settlement.settle(share.billId, share.from, share.to, share.amount, share.deadline, sig)
    ).to.be.revertedWith('Expired');
  });
});
