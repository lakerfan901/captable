import { render } from "react-email";
import { describe, expect, it } from "vitest";
import { CallNoticeEmail } from "../../../emails/llc/CallNoticeEmail";
import { OA_DEFAULTS } from "../../../lib/llc/config";
import { callNoticeDueDate } from "../../../lib/llc/default";
import {
  calendarDate,
  callNoticeReference,
  callNoticeSubject,
  commitmentFigures,
  formatNoticeAmounts,
  lineFigures,
  longDate,
  MAIL_CATCHER_BLOCKED,
  maskedAccountNumber,
  noticeAmounts,
  planBalancePayment,
  planPrepaidMatch,
  sendBlockedReason,
} from "./call-notices.logic";

const $ = (dollars: number) => BigInt(dollars) * 100n;

describe("planBalancePayment (R29)", () => {
  const twoLines = [
    {
      lineId: "L1",
      dueOn: "2027-01-20",
      outstanding: $(30_000),
      createdSeq: 0,
    },
    {
      lineId: "L2",
      dueOn: "2027-02-10",
      outstanding: $(30_000),
      createdSeq: 1,
    },
  ];

  it("CN-6: $50,000 on 2027-01-19 against two open lines", () => {
    const plan = planBalancePayment({
      amount: $(50_000),
      receivedOn: "2027-01-19",
      openLines: twoLines,
      rule: "LATER_OF_RECEIPT_AND_DUE",
    });
    expect(plan.allocations).toEqual([
      {
        lineId: "L1",
        amount: $(30_000),
        prefReturnStartOn: "2027-01-20",
        dueOn: "2027-01-20",
      },
      {
        lineId: "L2",
        amount: $(20_000),
        prefReturnStartOn: "2027-02-10",
        dueOn: "2027-02-10",
      },
    ]);
    expect(plan.unallocated).toBe(0n);
    expect(plan.firstDueOn).toBe("2027-01-20");
    expect(plan.receiptDueDate).toBe("2027-01-20");
  });

  it("CN-6r: same with rule RECEIPT_DATE", () => {
    const plan = planBalancePayment({
      amount: $(50_000),
      receivedOn: "2027-01-19",
      openLines: twoLines,
      rule: "RECEIPT_DATE",
    });
    expect(
      plan.allocations.map((a) => [a.lineId, a.amount, a.prefReturnStartOn]),
    ).toEqual([
      ["L1", $(30_000), "2027-01-19"],
      ["L2", $(20_000), "2027-01-19"],
    ]);
    expect(plan.unallocated).toBe(0n);
    expect(plan.receiptDueDate).toBe("2027-01-20");
  });

  it("CN-7: $70,000 on 2027-01-25 against one $60,000 line due 2027-01-20", () => {
    const plan = planBalancePayment({
      amount: $(70_000),
      receivedOn: "2027-01-25",
      openLines: [
        {
          lineId: "L1",
          dueOn: "2027-01-20",
          outstanding: $(60_000),
          createdSeq: 0,
        },
      ],
      rule: "LATER_OF_RECEIPT_AND_DUE",
    });
    expect(plan.allocations).toEqual([
      {
        lineId: "L1",
        amount: $(60_000),
        prefReturnStartOn: "2027-01-25",
        dueOn: "2027-01-20",
      },
    ]);
    expect(plan.unallocated).toBe($(10_000));
    expect(plan.firstDueOn).toBe("2027-01-20");
    // $10,000 unallocated: no due date goes to FOUNDATION, so the remainder
    // keeps its prepaid start 2027-03-31 (not 2027-01-25).
    expect(plan.receiptDueDate).toBeNull();
    // late: the slice was received after its due date
    const [slice] = plan.allocations;
    expect(slice && slice.amount > 0n && "2027-01-25" > slice.dueOn).toBe(true);
  });

  it("no open lines: everything is prepaid, no due date", () => {
    const plan = planBalancePayment({
      amount: $(5_000),
      receivedOn: "2027-01-05",
      openLines: [],
      rule: "LATER_OF_RECEIPT_AND_DUE",
    });
    expect(plan.allocations).toEqual([]);
    expect(plan.unallocated).toBe($(5_000));
    expect(plan.firstDueOn).toBeNull();
    expect(plan.receiptDueDate).toBeNull();
  });
});

describe("planPrepaidMatch (R28)", () => {
  const receipts = [
    // given out of order on purpose: oldest first is the rule
    { receiptId: "r2", receivedOn: "2026-12-10", unallocated: $(15_000) },
    { receiptId: "r1", receivedOn: "2026-12-01", unallocated: $(20_000) },
  ];

  it("line $30,000 due 2027-01-20: r1 $20,000 + r2 $10,000, both start 2027-01-20", () => {
    const m = planPrepaidMatch({
      lineAmount: $(30_000),
      dueOn: "2027-01-20",
      rule: "LATER_OF_RECEIPT_AND_DUE",
      prepaidReceipts: receipts,
    });
    expect(m.allocations).toEqual([
      {
        receiptId: "r1",
        amount: $(20_000),
        receivedOn: "2026-12-01",
        prefReturnStartOn: "2027-01-20",
      },
      {
        receiptId: "r2",
        amount: $(10_000),
        receivedOn: "2026-12-10",
        prefReturnStartOn: "2027-01-20",
      },
    ]);
    expect(m.total).toBe($(30_000));
    expect(m.fullyAllocatedReceiptIds).toEqual(["r1"]);
    expect(m.setStartReceipts).toEqual([
      { receiptId: "r1", startDate: "2027-01-20" },
    ]);
    // r2 keeps $5,000 unallocated (its receipt start stays 2027-03-31)
    const r2 = m.allocations.find((a) => a.receiptId === "r2");
    expect($(15_000) - (r2?.amount ?? 0n)).toBe($(5_000));
  });

  it("same with rule RECEIPT_DATE: slices start on their receipt dates, no start-date moves", () => {
    const m = planPrepaidMatch({
      lineAmount: $(30_000),
      dueOn: "2027-01-20",
      rule: "RECEIPT_DATE",
      prepaidReceipts: receipts,
    });
    expect(
      m.allocations.map((a) => [a.receiptId, a.amount, a.prefReturnStartOn]),
    ).toEqual([
      ["r1", $(20_000), "2026-12-01"],
      ["r2", $(10_000), "2026-12-10"],
    ]);
    expect(m.fullyAllocatedReceiptIds).toEqual(["r1"]);
    expect(m.setStartReceipts).toEqual([]);
  });

  it("acceptance: $20,000 prepaid on a $30,000 call → already received $20,000.00, amount due $10,000.00", () => {
    const m = planPrepaidMatch({
      lineAmount: $(30_000),
      dueOn: "2027-01-20",
      rule: "LATER_OF_RECEIPT_AND_DUE",
      prepaidReceipts: [
        { receiptId: "r1", receivedOn: "2026-12-01", unallocated: $(20_000) },
      ],
    });
    const amounts = formatNoticeAmounts(
      noticeAmounts({
        committed: $(100_000),
        paidToDate: $(60_000),
        uncalledBefore: $(60_000),
        amountCalled: $(30_000),
        alreadyReceived: m.total,
      }),
    );
    expect(amounts.alreadyReceived).toBe("$20,000.00");
    expect(amounts.amountDue).toBe("$10,000.00");
    expect(amounts.remainingAfter).toBe("$30,000.00");
  });

  it("a receipt dated after the due date starts on its receipt date (max), and skips empty receipts", () => {
    const m = planPrepaidMatch({
      lineAmount: $(30_000),
      dueOn: "2027-03-31",
      rule: "LATER_OF_RECEIPT_AND_DUE",
      prepaidReceipts: [
        { receiptId: "r0", receivedOn: "2026-12-01", unallocated: 0n },
        { receiptId: "r3", receivedOn: "2027-04-02", unallocated: $(30_000) },
      ],
    });
    expect(m.allocations).toEqual([
      {
        receiptId: "r3",
        amount: $(30_000),
        receivedOn: "2027-04-02",
        prefReturnStartOn: "2027-04-02",
      },
    ]);
    expect(m.setStartReceipts).toEqual([
      { receiptId: "r3", startDate: "2027-04-02" },
    ]);
  });

  it("no prepaid money: nothing allocated", () => {
    const m = planPrepaidMatch({
      lineAmount: $(30_000),
      dueOn: "2027-01-20",
      rule: "LATER_OF_RECEIPT_AND_DUE",
      prepaidReceipts: [],
    });
    expect(m).toEqual({
      allocations: [],
      total: 0n,
      fullyAllocatedReceiptIds: [],
      setStartReceipts: [],
    });
  });
});

describe("commitmentFigures", () => {
  it("$100,000 accepted, $40,000 initial, $30,000 called, $20,000 prepaid of which $5,000 allocated", () => {
    const f = commitmentFigures({
      acceptedCents: $(100_000),
      receipts: [
        { kind: "INITIAL", appliedCents: $(40_000) },
        { kind: "BALANCE", appliedCents: $(20_000) },
        { kind: "CREDIT", appliedCents: $(1_000) },
      ],
      netAllocated: $(5_000),
      calledTotal: $(30_000),
      replacementFunded: 0n,
    });
    expect(f).toEqual({
      replacementFunded: 0n,
      initialPaid: $(40_000),
      balance: $(60_000),
      calledTotal: $(30_000),
      uncalled: $(30_000),
      balancePaid: $(20_000),
      prepaidUnallocated: $(15_000),
      totalPaid: $(60_000),
      remainingCommitment: $(40_000),
    });
  });

  it("replacement funding does not reduce the uncalled Balance (R26)", () => {
    // accepted already reduced from 100,000 to 70,000 by $30,000 of funding
    const f = commitmentFigures({
      acceptedCents: $(70_000),
      receipts: [{ kind: "INITIAL", appliedCents: $(40_000) }],
      netAllocated: 0n,
      calledTotal: $(60_000),
      replacementFunded: $(30_000),
    });
    expect(f.uncalled).toBe(0n);
    expect(f.remainingCommitment).toBe($(30_000));
  });
});

describe("lineFigures", () => {
  const base = {
    amountCalled: $(60_000),
    allocated: $(20_000),
    replacementFunded: $(10_000),
    status: "SENT",
    dueOn: "2027-01-20",
  };
  it("outstanding nets allocations and fundings; overdue from the day after the due date", () => {
    expect(lineFigures({ ...base, today: "2027-01-20" })).toEqual({
      outstanding: $(30_000),
      overdue: false,
    });
    expect(lineFigures({ ...base, today: "2027-01-21" }).overdue).toBe(true);
  });
  it("PAID, UNSENT or fully paid lines are never overdue", () => {
    expect(
      lineFigures({ ...base, status: "PAID", today: "2027-02-01" }).overdue,
    ).toBe(false);
    expect(
      lineFigures({
        ...base,
        status: "UNSENT",
        dueOn: null,
        today: "2027-02-01",
      }).overdue,
    ).toBe(false);
    expect(
      lineFigures({ ...base, allocated: $(50_000), today: "2027-02-01" }),
    ).toEqual({ outstanding: 0n, overdue: false });
  });
});

describe("email text", () => {
  it("sent 2027-01-14 → due Wednesday, January 20, 2027", () => {
    const dueOn = callNoticeDueDate("2027-01-14", OA_DEFAULTS);
    expect(dueOn).toBe("2027-01-20");
    expect(longDate(dueOn)).toBe("Wednesday, January 20, 2027");
    expect(longDate("2027-03-31")).toBe("Wednesday, March 31, 2027");
    expect(calendarDate("2027-03-31")).toBe("March 31, 2027");
  });

  it("subject", () => {
    expect(
      callNoticeSubject({
        noticeNumber: 1,
        companyName: "Octagon GPU I LLC",
        amountDue: "$10,000.00",
        dueOnLong: "Wednesday, January 20, 2027",
      }),
    ).toBe(
      "Call Notice No. 1 – Octagon GPU I LLC – $10,000.00 due Wednesday, January 20, 2027",
    );
  });

  it("reference is truncated to 80 characters", () => {
    expect(callNoticeReference("Octagon GPU I LLC", 2, "Jane Doe")).toBe(
      "Octagon GPU I LLC CN2 Jane Doe",
    );
    const long = callNoticeReference("A".repeat(60), 12, "B".repeat(40));
    expect(long).toHaveLength(80);
    expect(long.startsWith(`${"A".repeat(60)} CN12 `)).toBe(true);
  });

  it("noticeAmounts never goes negative", () => {
    expect(
      noticeAmounts({
        committed: $(100_000),
        paidToDate: $(100_000),
        uncalledBefore: $(10_000),
        amountCalled: $(30_000),
        alreadyReceived: $(40_000),
      }),
    ).toMatchObject({ amountDue: 0n, remainingAfter: 0n });
  });

  it("masks the account number", () => {
    expect(maskedAccountNumber("000123456789")).toBe("•••• 6789");
  });
});

describe("sendBlockedReason", () => {
  it("refuses the mail catcher only in production", () => {
    expect(
      sendBlockedReason({ nodeEnv: "production", mailCatcher: true }),
    ).toBe(MAIL_CATCHER_BLOCKED);
    expect(
      sendBlockedReason({ nodeEnv: "production", mailCatcher: false }),
    ).toBeNull();
    expect(
      sendBlockedReason({ nodeEnv: "development", mailCatcher: true }),
    ).toBeNull();
    expect(sendBlockedReason({ nodeEnv: undefined, mailCatcher: true })).toBe(
      null,
    );
  });
});

describe("CallNoticeEmail", () => {
  it("renders the due date, the amounts and the wire block in order", async () => {
    const props = CallNoticeEmail.PreviewProps;
    const text = await render(CallNoticeEmail(props), { plainText: true });
    expect(text).toContain("Payment is due by Wednesday, January 20, 2027");
    expect(text).toContain("not later than March 31, 2027");
    expect(text).toContain("$20,000.00");
    expect(text).toContain("$10,000.00");
    expect(text).toContain("Octagon GPU I LLC CN1 Jane Doe");
    const order = [
      "Dear Jane Doe,",
      "This is a Call Notice under Section 4.9",
      "Amount called by this notice",
      "Already received toward this call",
      "Payment is due by",
      "Wire instructions",
      "Wire instructions will not be changed by email",
      "Preferred Units are issued at one Unit per $1,000",
      "interest at 12%",
      "Questions: Karl Example, manager@example.com.",
    ].map((t) => text.indexOf(t));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).not.toContain("Powered by");
  });
});
