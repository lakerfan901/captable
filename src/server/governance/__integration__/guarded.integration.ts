/**
 * Proves `guardedWrite` (src/server/governance/guarded.ts) against a real
 * Postgres: two writers race on the same guard and exactly one wins. Not part
 * of `vitest run` (it needs Postgres). Run from the repository root against a
 * LOCAL database only:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   NEXTAUTH_SECRET=test-secret \
 *   node_modules/.bin/tsx \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/governance/__integration__/guarded.integration.ts
 *
 * Each race: writer 1 applies its guarded write inside a transaction and holds
 * the row lock; writer 2 starts the same guarded write (in its own
 * transaction, or with no transaction) and blocks; writer 1 commits; writer 2
 * must then see "not applied". The same race with `updateMany` is run first
 * as a control and is expected to let both writers "win" (the Prisma 7
 * behaviour this helper exists for). It creates one throwaway company and
 * deletes everything it created in a `finally`.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { guardedWrite } from "@/server/governance/guarded";

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  throw new Error("Refusing to run: DATABASE_URL is not a local database");
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` (${detail})` : ""}`,
  );
  if (!ok) failures++;
}

/** Writer 1 holds its write open until writer 2 has started and is blocked. */
async function race(
  first: (tx: typeof db) => Promise<boolean>,
  second: () => Promise<boolean>,
): Promise<[boolean, boolean]> {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let held: () => void = () => {};
  const isHeld = new Promise<void>((r) => {
    held = r;
  });
  const t1 = db.$transaction(
    async (tx) => {
      const won = await first(tx as unknown as typeof db);
      held();
      await gate;
      return won;
    },
    { timeout: 20_000 },
  );
  await isHeld;
  const t2 = second();
  await new Promise((r) => setTimeout(r, 500));
  release();
  return await Promise.all([t1, t2]);
}

const created = { companyId: "", userId: "" };

async function main() {
  const company = await db.company.create({
    data: {
      name: `zz-guarded-race ${new Date().toISOString()}`,
      publicId: `zz-guarded-${randomUUID()}`,
      incorporationType: "llc",
      incorporationDate: new Date("2026-01-01"),
      incorporationCountry: "US",
      incorporationState: "WY",
      streetAddress: "1 Test St",
      city: "Cheyenne",
      state: "WY",
      zipcode: "82001",
      country: "US",
      entityType: "LLC",
    },
  });
  created.companyId = company.id;
  const user = await db.user.create({
    data: { name: "Race", email: `zz-guarded-${randomUUID()}@example.com` },
  });
  created.userId = user.id;
  const member = await db.member.create({
    data: {
      companyId: company.id,
      userId: user.id,
      status: "ACTIVE",
      role: "ADMIN",
    },
  });
  const newResolution = () =>
    db.resolution.create({
      data: {
        publicId: `zz-guarded-${randomUUID()}`,
        companyId: company.id,
        type: "GENERAL_CONSENT",
        status: "DRAFT",
        title: "race",
        params: {},
        body: [],
        authorId: member.id,
      },
    });

  console.log("control: guarded updateMany (expected to be unsafe)");
  {
    const r = await newResolution();
    const write = (c: typeof db, v: string) =>
      c.resolution
        .updateMany({
          where: { id: r.id, withdrawnReason: null },
          data: { withdrawnReason: v },
        })
        .then((x) => x.count === 1);
    const [a, b] = await race(
      (tx) => write(tx, "first"),
      () =>
        db.$transaction((tx) => write(tx as unknown as typeof db, "second")),
    );
    console.log(
      `  updateMany: writer1=${a} writer2=${b} (both true = lost update)`,
    );
  }

  console.log("guardedWrite(update): second writer in a transaction");
  {
    const r = await newResolution();
    const write = (c: typeof db, v: string) =>
      guardedWrite(() =>
        c.resolution.update({
          where: { id: r.id, withdrawnReason: null },
          data: { withdrawnReason: v },
          select: { id: true },
        }),
      );
    let followUp = "";
    const [a, b] = await race(
      (tx) => write(tx, "first"),
      () =>
        db.$transaction(async (tx) => {
          const won = await write(tx as unknown as typeof db, "second");
          // The transaction must still be usable after "not applied".
          await tx.resolution.update({
            where: { id: r.id },
            data: { title: "follow-up" },
          });
          followUp = "committed";
          return won;
        }),
    );
    const row = await db.resolution.findUniqueOrThrow({ where: { id: r.id } });
    check("exactly one writer wins", a && !b, `writer1=${a} writer2=${b}`);
    check(
      "the winner's value is kept",
      row.withdrawnReason === "first",
      String(row.withdrawnReason),
    );
    check(
      "a later statement in the loser's transaction commits",
      followUp === "committed" && row.title === "follow-up",
      `${followUp} title=${row.title}`,
    );
  }

  console.log("guardedWrite(update): second writer outside any transaction");
  {
    const r = await newResolution();
    const write = (c: typeof db, v: string) =>
      guardedWrite(() =>
        c.resolution.update({
          where: { id: r.id, status: "DRAFT" },
          data: { status: v === "first" ? "SENT" : "WITHDRAWN", title: v },
          select: { id: true },
        }),
      );
    const [a, b] = await race(
      (tx) => write(tx, "first"),
      () => write(db, "second"),
    );
    const row = await db.resolution.findUniqueOrThrow({ where: { id: r.id } });
    check("exactly one writer wins", a && !b, `writer1=${a} writer2=${b}`);
    check(
      "status and title are the winner's",
      row.status === "SENT" && row.title === "first",
      `${row.status} ${row.title}`,
    );
  }

  console.log(
    "guardedWrite(delete) on a parent with emulated cascade children",
  );
  {
    const r = await newResolution();
    await db.resolutionEvent.create({
      data: {
        resolutionId: r.id,
        companyId: company.id,
        type: "SENT",
        actorType: "system",
        summary: "child row",
      },
    });
    const [a, b] = await race(
      (tx) =>
        guardedWrite(() =>
          tx.resolution.update({
            where: { id: r.id, status: "DRAFT" },
            data: { status: "SENT" },
            select: { id: true },
          }),
        ),
      () =>
        db.$transaction((tx) =>
          guardedWrite(() =>
            tx.resolution.delete({
              where: { id: r.id, status: "DRAFT" },
              select: { id: true },
            }),
          ),
        ),
    );
    const row = await db.resolution.findUnique({ where: { id: r.id } });
    const children = await db.resolutionEvent.count({
      where: { resolutionId: r.id },
    });
    check(
      "the update wins, the guarded delete is not applied",
      a && !b,
      `update=${a} delete=${b}`,
    );
    check(
      "the parent and its child survive",
      row?.status === "SENT" && children === 1,
      `${row?.status} children=${children}`,
    );
  }

  console.log("guardedWrite: missing row");
  check(
    "a missing id is 'not applied', not an error",
    (await guardedWrite(() =>
      db.resolution.update({
        where: { id: "does-not-exist", status: "DRAFT" },
        data: { title: "x" },
      }),
    )) === false,
  );
}

try {
  await main();
} finally {
  if (created.companyId) {
    await db.resolutionEvent.deleteMany({
      where: { companyId: created.companyId },
    });
    await db.resolution.deleteMany({ where: { companyId: created.companyId } });
    await db.member.deleteMany({ where: { companyId: created.companyId } });
    await db.company.delete({ where: { id: created.companyId } });
  }
  if (created.userId) await db.user.delete({ where: { id: created.userId } });
  const left = created.companyId
    ? await db.resolution.count({ where: { companyId: created.companyId } })
    : 0;
  console.log(`cleanup: resolutions left ${left}`);
  console.log(
    failures === 0
      ? "\nall guarded-write checks passed"
      : `\n${failures} check(s) FAILED`,
  );
  await db.$disconnect();
  if (failures > 0) process.exitCode = 1;
}
