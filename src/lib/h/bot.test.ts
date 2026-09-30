import assert from "node:assert/strict";
import test from "node:test";
import { expandPacket } from "./bot.ts";

test("paket ređa spisak, račun, rashod i zatvaranje i deli ključ", () => {
  const actions = expandPacket({
    kljuc: "dan-1",
    artikli: [{ naziv: "Meso", jedinica: "g" }],
    racuni: [{ dobavljac: "Mesara", broj: "12", stavke: [] }],
    rashodi: [{ artikal: "Meso", kolicina: "10", jedinica: "g", razlog: "Prosipanje" }],
    zatvaranje: { izbrojano: "100" },
  });
  assert.deepEqual(actions.map((action) => action.op), ["artikal", "racun", "rashod", "smena_zatvori"]);
  assert.equal(actions[1]?.body.idempotencyKey, "dan-1:racun:1");
  assert.equal(actions[2]?.body.idempotencyKey, "dan-1:rashod:2");
  assert.equal(actions[3]?.body.izbrojano, "100");
});

test("račun bez ključa se odbija da se ne bi udvostručio", () => {
  assert.throws(() => expandPacket({ op: "racun", dobavljac: "Mesara" }), /kljuc/);
});

test("polje artikal uz op nije pogrešno pročitano kao drugi paket", () => {
  const actions = expandPacket({
    op: "rashod",
    kljuc: "r1",
    artikal: "Meso",
    kolicina: "10",
    jedinica: "g",
    razlog: "Prosipanje",
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.op, "rashod");
  assert.equal(actions[0]?.body.artikal, "Meso");
});

test("op i paket zajedno se odbijaju", () => {
  assert.throws(() => expandPacket({ op: "artikal", naziv: "Meso", artikli: [{ naziv: "Sir" }] }), /ne oba/);
});
