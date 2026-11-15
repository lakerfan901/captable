import { describe, expect, it } from "vitest";
import { accessActions, describeAccess } from "./access-admin-core";

const now = new Date("2026-11-15T12:00:00Z");
const invitedAt = new Date("2026-11-10T12:00:00Z");
const before = new Date("2026-11-01T12:00:00Z");
const after = new Date("2026-11-11T12:00:00Z");

const noUser = { passwordSetAt: null, lockedUntil: null };

describe("describeAccess", () => {
  it("is INVITED before the person sets a password", () => {
    expect(
      describeAccess(
        { status: "ACTIVE", invitedAt, lastSeenAt: null },
        noUser,
        now,
      ),
    ).toEqual({ state: "INVITED", passwordSet: false, locked: false });
  });

  it("is ACTIVE once a password is set after the invitation", () => {
    const v = describeAccess(
      { status: "ACTIVE", invitedAt, lastSeenAt: null },
      { passwordSetAt: after, lockedUntil: null },
      now,
    );
    expect(v.state).toBe("ACTIVE");
    expect(v.passwordSet).toBe(true);
  });

  it("does not reveal a password set earlier for another holder or company", () => {
    const v = describeAccess(
      { status: "ACTIVE", invitedAt, lastSeenAt: null },
      { passwordSetAt: before, lockedUntil: null },
      now,
    );
    expect(v).toEqual({ state: "INVITED", passwordSet: false, locked: false });
  });

  it("is ACTIVE once the person opened this holder, whenever the password was set", () => {
    const v = describeAccess(
      { status: "ACTIVE", invitedAt, lastSeenAt: after },
      { passwordSetAt: before, lockedUntil: null },
      now,
    );
    expect(v.state).toBe("ACTIVE");
  });

  it("a password set at the same instant as the invitation counts", () => {
    const v = describeAccess(
      { status: "ACTIVE", invitedAt, lastSeenAt: null },
      { passwordSetAt: invitedAt, lockedUntil: null },
      now,
    );
    expect(v.passwordSet).toBe(true);
  });

  it("DISABLED wins over everything", () => {
    const v = describeAccess(
      { status: "DISABLED", invitedAt, lastSeenAt: after },
      { passwordSetAt: after, lockedUntil: null },
      now,
    );
    expect(v.state).toBe("DISABLED");
  });

  it("locked only while lockedUntil is in the future", () => {
    const access = { status: "ACTIVE" as const, invitedAt, lastSeenAt: null };
    expect(
      describeAccess(
        access,
        { passwordSetAt: null, lockedUntil: new Date(now.getTime() + 1000) },
        now,
      ).locked,
    ).toBe(true);
    expect(
      describeAccess(access, { passwordSetAt: null, lockedUntil: now }, now)
        .locked,
    ).toBe(false);
  });
});

describe("accessActions", () => {
  it("offers resend and disable to an invited access", () => {
    expect(
      accessActions({ state: "INVITED", passwordSet: false, locked: false }),
    ).toEqual({ resend: true, unlock: false, disable: true, enable: false });
  });

  it("offers unlock to a locked active access, no resend after set-up", () => {
    expect(
      accessActions({ state: "ACTIVE", passwordSet: true, locked: true }),
    ).toEqual({ resend: false, unlock: true, disable: true, enable: false });
  });

  it("offers only enable to a disabled access", () => {
    expect(
      accessActions({ state: "DISABLED", passwordSet: true, locked: true }),
    ).toEqual({ resend: false, unlock: false, disable: false, enable: true });
  });
});
