async function main(){
  const { cumulativeSpend } = await import("./src/lib/__bench__/modelcache");
  const t = cumulativeSpend();
  const spentThisRun = t.usd - 4.07;
  console.log(`cumulative ~$${t.usd.toFixed(2)} over ${t.calls} calls`);
  console.log(`this run   ~$${spentThisRun.toFixed(2)} of your $2.96`);
}
main();
