// A real response-owned child. Termination acknowledgement deliberately precedes close.
const [origin, id, mode] = process.argv.slice(2);
let closing;
async function post(event, value = {}) {
  const response = await fetch(new URL(`/child/${id}/${event}`, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pid: process.pid, ...value }),
  });
  if (!response.ok) throw new Error(`Fixture child ${event} refused: ${response.status}`);
  return response;
}
function close() {
  closing ??= (async () => {
    await post("termination-ack");
    const response = await post("cleanup");
    const { fail } = await response.json();
    process.exitCode = fail ? 23 : 0;
    if (process.connected) process.disconnect();
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
  return closing;
}
process.on("message", (message) => {
  if (message === "terminate") void close();
});
process.on("disconnect", () => void close());
process.on("SIGTERM", () => void close());
post("ready").then(
  () => {
    if (mode === "complete") void close();
  },
  (error) => {
    console.error(error.message);
    process.exit(1);
  },
);
