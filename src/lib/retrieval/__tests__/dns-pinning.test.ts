import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Agent } from "undici";
import { pinnedAgent, type CheckedUrl } from "../resolvers/urlguard";

// Closes DEFERRED.md's SSRF DNS pinning item.
//
// The guard resolves a hostname and checks every address it points at, then the
// socket resolves the name AGAIN when it connects. Those are two separate
// resolutions, so a record that changes in between sends the connection
// somewhere the guard never cleared. That is DNS rebinding, and re-checking the
// URL cannot close it, because the second resolution is the problem.
//
// These tests use real sockets: a pin is only meaningful if it survives an
// actual connection.

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

function checked(url: string, address: string | null): CheckedUrl {
  return { url: new URL(url), pinnedAddress: address, pinnedFamily: address ? 4 : null };
}

test("a pinned connection ignores what DNS says at connect time", async () => {
  // Stands in for the address the guard cleared.
  const cleared = createServer((_req, res) => {
    res.writeHead(200);
    res.end("cleared-host");
  });
  const clearedPort = await listen(cleared);

  // A hostname that does not resolve at all. If the pin is honoured the request
  // still lands on the cleared address; if it is not, the request cannot even
  // connect, which is itself proof the pin did the work.
  const agent = pinnedAgent(checked(`http://rebound.invalid:${clearedPort}/`, "127.0.0.1"));
  assert.ok(agent, "expected a pinned agent");

  try {
    const response = await fetch(`http://rebound.invalid:${clearedPort}/`, {
      dispatcher: agent
    } as RequestInit);
    assert.equal(await response.text(), "cleared-host");
  } finally {
    await agent!.close();
    cleared.close();
  }
});

test("the pin, not the hostname, decides where the socket goes", async () => {
  // Two servers. The guard "cleared" the first; a rebinding attack would send
  // the connection to the second. The pin must keep it on the first.
  const clearedServer = createServer((_req, res) => {
    res.writeHead(200);
    res.end("SAFE");
  });
  const attackerServer = createServer((_req, res) => {
    res.writeHead(200);
    res.end("INTERNAL-SERVICE");
  });

  const safePort = await listen(clearedServer);
  await listen(attackerServer);

  // A dispatcher whose lookup is pinned to the safe port's host. Both servers
  // are on 127.0.0.1, so the port is what distinguishes them; the point being
  // asserted is that the pinned lookup is consulted and honoured.
  const agent = pinnedAgent(checked(`http://example.invalid:${safePort}/`, "127.0.0.1"));

  try {
    const response = await fetch(`http://example.invalid:${safePort}/`, {
      dispatcher: agent
    } as RequestInit);
    const body = await response.text();
    assert.equal(body, "SAFE");
    assert.notEqual(body, "INTERNAL-SERVICE");
  } finally {
    await agent!.close();
    clearedServer.close();
    attackerServer.close();
  }
});

test("a pinned agent is a real undici Agent", () => {
  const agent = pinnedAgent(checked("http://example.test/", "93.184.216.34"));
  assert.ok(agent instanceof Agent);
  void agent!.close();
});

test("nothing is pinned when the guard had no address to clear", () => {
  // A literal IP has no name to re-resolve, so there is no rebinding window and
  // no reason to constrain the dispatcher.
  assert.equal(pinnedAgent(checked("http://93.184.216.34/", null)), null);
});
