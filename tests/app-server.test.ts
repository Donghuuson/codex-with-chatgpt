import { describe, expect, it } from "vitest";
import { AppServerClient } from "../src/execution/app-server.js";

const fakeServer = `
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') console.log(JSON.stringify({id:msg.id,result:{}}));
  else if (msg.method === 'thread/start') console.log(JSON.stringify({id:msg.id,result:{thread:{id:'thread-1'}}}));
  else if (msg.method === 'bad') console.log(JSON.stringify({id:msg.id,error:{message:'bad request'}}));
});`;

describe("App Server transport", () => {
  it("initializes, sends requests, and surfaces RPC errors", async () => {
    const client = new AppServerClient(process.execPath, ["-e", fakeServer]);
    try {
      await client.initialize();
      expect(await client.request("thread/start", {})).toEqual({ thread: { id: "thread-1" } });
      await expect(client.request("bad", {})).rejects.toThrow("bad request");
      await expect(client.request("silent", {}, 30)).rejects.toThrow("timed out");
    } finally { client.close(); }
  });
});
