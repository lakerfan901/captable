"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { RiInformationLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { type Resolver, useForm } from "react-hook-form";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  describeRequirements,
  MATTERS,
  PRE_APPROVED_RELATED_PARTY,
  PROTECTED_PROVISIONS,
  paramsSchema,
  type ResolutionType,
} from "@/lib/governance/presets";
import { cn } from "@/lib/utils";
import { api } from "@/trpc/react";
import { RESOLUTION_TYPE_LABEL } from "./resolution-table";

// Parameter form for one resolution type (03-governance.md G10), plus the
// two-step "new resolution" flow used by `/resolutions/new`.

type FormValues = Record<string, unknown>;

export interface PresetMember {
  id: string;
  name: string;
}

type FieldKind =
  | "text"
  | "textarea"
  | "money"
  | "date"
  | "int"
  | "switch"
  | "select"
  | "matter"
  | "bases"
  | "protected"
  | "members";

interface FieldSpec {
  name: string;
  label: string;
  kind: FieldKind;
  description?: string;
  optional?: boolean;
  options?: { value: string; label: string }[];
}

const VOTE_BASIS_OPTIONS = [
  { value: "PREFERRED_MAJORITY", label: "Preferred Majority (more than 50%)" },
  {
    value: "PREFERRED_SUPERMAJORITY",
    label: "Preferred Supermajority (at least 70%)",
  },
  {
    value: "DISINTERESTED_MAJORITY",
    label: "Majority of the Disinterested Preferred Units",
  },
  {
    value: "DISINTERESTED_67",
    label: "67% of the Disinterested Preferred Units",
  },
  {
    value: "DISINTERESTED_70",
    label: "70% of the Disinterested Preferred Units",
  },
];

const FIELDS: Record<ResolutionType, FieldSpec[]> = {
  GENERAL_CONSENT: [
    { name: "matterKey", label: "Matter", kind: "matter" },
    {
      name: "requireManagerApproval",
      label: "Also require the approval of the Manager",
      kind: "switch",
    },
    {
      name: "additionalBases",
      label: "Additional vote requirements",
      kind: "bases",
      description:
        "You may add requirements to those the Agreement sets; you cannot lower them.",
    },
  ],
  RELATED_PARTY: [
    { name: "counterparty", label: "Counterparty", kind: "text" },
    {
      name: "relationship",
      label: "Relationship to the LLC",
      kind: "text",
      description: "For example: Affiliate of the Manager.",
    },
    { name: "description", label: "Transaction", kind: "textarea" },
    { name: "amount", label: "Amount (USD)", kind: "money", optional: true },
  ],
  PURCHASE_ORDER: [
    { name: "vendor", label: "Vendor", kind: "text" },
    { name: "equipment", label: "Equipment", kind: "textarea" },
    { name: "price", label: "Price", kind: "money" },
    { name: "currency", label: "Currency", kind: "text" },
    {
      name: "poReference",
      label: "Purchase order reference",
      kind: "text",
      optional: true,
    },
    { name: "managerName", label: "Manager", kind: "text" },
    {
      name: "purchasingAgentName",
      label: "Purchasing agent",
      kind: "text",
      description: "The Manager or the Affiliate placing the order as agent.",
    },
  ],
  TERM_EXTENSION: [
    {
      name: "currentTargetSaleDate",
      label: "Current Target Sale Date",
      kind: "date",
    },
    { name: "extensionNumber", label: "Extension number", kind: "int" },
  ],
  MANAGER_REMOVAL: [
    { name: "managerName", label: "Manager to be removed", kind: "text" },
    {
      name: "requestedBy",
      label: "Requested by",
      kind: "textarea",
      optional: true,
      description: "The Members who asked for this consent in writing.",
    },
  ],
  SUCCESSOR_MANAGER: [
    { name: "successorName", label: "Successor Manager", kind: "text" },
    {
      name: "reason",
      label: "Reason",
      kind: "select",
      options: [
        { value: "REMOVAL", label: "Removal of the Manager" },
        { value: "RESIGNATION", label: "Resignation of the Manager" },
      ],
    },
  ],
  AMENDMENT: [
    { name: "summary", label: "Summary of the amendment", kind: "textarea" },
    {
      name: "touchesProtectedProvision",
      label: "Amends a provision listed in Section 12.1(c)",
      kind: "switch",
      description: "Adds approval by 70% of the Disinterested Preferred Units.",
    },
    { name: "protectedSections", label: "Provisions", kind: "protected" },
    {
      name: "adverseToCommon",
      label: "Adversely affects the rights of the Common Units",
      kind: "switch",
      description: "Adds the approval of the Common Member (Section 12.1(d)).",
    },
    {
      name: "affectedMemberIds",
      label: "Members disproportionately and adversely affected",
      kind: "members",
      description: "Each selected Member must also consent (Section 12.1(b)).",
    },
  ],
  AUDIT_CALL: [
    { name: "fiscalYear", label: "Fiscal year", kind: "int" },
    {
      name: "scope",
      label: "Scope",
      kind: "select",
      options: [
        { value: "REVIEW", label: "Review" },
        { value: "AUDIT", label: "Audit" },
      ],
    },
    {
      name: "periodDescription",
      label: "Period and books covered",
      kind: "textarea",
    },
  ],
  MEMBER_LOAN: [
    { name: "lenderName", label: "Lender", kind: "text" },
    {
      name: "lenderIsInsider",
      label: "Lender is the Manager, Isaac Reid, Karl Schoen or an Affiliate",
      kind: "switch",
      description:
        "Adds approval by a majority of the Disinterested Preferred Units (Section 6.16(i)).",
    },
    { name: "principal", label: "Principal (USD)", kind: "money" },
    { name: "interestRate", label: "Interest rate", kind: "text" },
    { name: "maturity", label: "Maturity", kind: "text" },
  ],
};

const GENERAL_MATTERS = Object.entries(MATTERS).filter(
  ([, m]) => m.presetType === null,
);

/** Empty parameters for a type, overlaid with `prefill`. */
export function defaultParams(
  type: ResolutionType,
  prefill: FormValues = {},
): FormValues {
  const base: Record<ResolutionType, FormValues> = {
    GENERAL_CONSENT: {
      matterKey: "OTHER",
      requireManagerApproval: false,
      additionalBases: [],
    },
    RELATED_PARTY: {
      counterparty: "",
      relationship: "",
      description: "",
      amount: "",
    },
    PURCHASE_ORDER: {
      vendor: "",
      equipment: "",
      price: "",
      currency: "USD",
      poReference: "",
      managerName: "",
      purchasingAgentName: "",
    },
    TERM_EXTENSION: { currentTargetSaleDate: "", extensionNumber: 1 },
    MANAGER_REMOVAL: { managerName: "", requestedBy: "" },
    SUCCESSOR_MANAGER: { successorName: "", reason: "REMOVAL" },
    AMENDMENT: {
      summary: "",
      touchesProtectedProvision: false,
      protectedSections: [],
      adverseToCommon: false,
      affectedMemberIds: [],
    },
    AUDIT_CALL: {
      fiscalYear: new Date().getFullYear(),
      scope: "REVIEW",
      periodDescription: "",
    },
    MEMBER_LOAN: {
      lenderName: "",
      lenderIsInsider: false,
      principal: "",
      interestRate: "",
      maturity: "",
    },
  };
  return { ...base[type], ...prefill };
}

/** Form values -> params the server accepts (optional money "" is omitted). */
export function cleanParams(
  type: ResolutionType,
  values: FormValues,
): FormValues {
  const out: FormValues = { ...values };
  for (const f of FIELDS[type]) {
    if (f.kind === "money" && f.optional && out[f.name] === "") {
      delete out[f.name];
    }
  }
  return out;
}

function presetResolver(type: ResolutionType): Resolver<FormValues> {
  const inner = zodResolver(
    paramsSchema(type) as unknown as Parameters<typeof zodResolver>[0],
  ) as unknown as Resolver<FormValues>;
  return (values, context, options) =>
    inner(cleanParams(type, values), context, options);
}

export interface ResolutionPresetFormProps {
  type: ResolutionType;
  /** Initial values (e.g. a draft's stored params); defaults are filled in. */
  defaultValues?: FormValues;
  /** Members offered for AMENDMENT `affectedMemberIds`. */
  members?: PresetMember[];
  /** Shown on the submit button; the button is hidden without `onSubmit`. */
  submitLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  /** Called with validated, cleaned params. */
  onSubmit?: (params: FormValues) => void;
  /** Called on every edit with the cleaned params and whether they validate. */
  onChange?: (params: FormValues, valid: boolean) => void;
  onCancel?: () => void;
}

export function ResolutionPresetForm({
  type,
  defaultValues,
  members = [],
  submitLabel,
  pending = false,
  disabled = false,
  onSubmit,
  onChange,
  onCancel,
}: ResolutionPresetFormProps) {
  const resolver = useMemo(() => presetResolver(type), [type]);
  const form = useForm<FormValues>({
    resolver,
    defaultValues: defaultParams(type, defaultValues),
  });

  useEffect(() => {
    if (!onChange) return;
    const sub = form.watch((values) => {
      const params = cleanParams(type, values as FormValues);
      onChange(params, paramsSchema(type).safeParse(params).success);
    });
    return () => sub.unsubscribe();
  }, [form, type, onChange]);

  const touchesProtected = form.watch("touchesProtectedProvision") === true;

  return (
    <Form {...form}>
      <form
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit((values) =>
          onSubmit?.(cleanParams(type, values)),
        )}
      >
        {type === "PURCHASE_ORDER" ? (
          <Alert>
            <RiInformationLine className="h-4 w-4" />
            <AlertDescription>
              Sign this resolution before any LLC funds are paid. It is required
              for a purchase order, or a series of related purchase orders, over
              $25,000 (Section 6.16(i)(B)). A copy is emailed to all Members
              when you sign.
            </AlertDescription>
          </Alert>
        ) : null}
        {type === "RELATED_PARTY" ? (
          <Alert>
            <RiInformationLine className="h-4 w-4" />
            <AlertTitle>No resolution is needed for:</AlertTitle>
            <AlertDescription>
              <ul className="mt-1 list-disc pl-5">
                {PRE_APPROVED_RELATED_PARTY.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <fieldset disabled={disabled} className="flex flex-col gap-4">
          {FIELDS[type].map((spec) => {
            if (spec.kind === "protected" && !touchesProtected) return null;
            return (
              <PresetField key={spec.name} spec={spec} members={members} />
            );
          })}
        </fieldset>

        {onSubmit || onCancel ? (
          <div className="flex justify-end gap-2">
            {onCancel ? (
              <Button type="button" variant="outline" onClick={onCancel}>
                Back
              </Button>
            ) : null}
            {onSubmit ? (
              <Button type="submit" loading={pending} disabled={disabled}>
                {submitLabel ?? "Save"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </form>
    </Form>
  );
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function toggle(list: string[], value: string, on: boolean): string[] {
  return on
    ? list.includes(value)
      ? list
      : [...list, value]
    : list.filter((v) => v !== value);
}

function PresetField({
  spec,
  members,
}: {
  spec: FieldSpec;
  members: PresetMember[];
}) {
  const label = spec.optional ? `${spec.label} (optional)` : spec.label;
  return (
    <FormField
      name={spec.name}
      render={({ field }) => {
        switch (spec.kind) {
          case "switch":
            return (
              <FormItem className="flex flex-row items-start justify-between gap-4 rounded-md border p-3">
                <div className="space-y-1">
                  <FormLabel>{label}</FormLabel>
                  {spec.description ? (
                    <FormDescription>{spec.description}</FormDescription>
                  ) : null}
                </div>
                <FormControl>
                  <Switch
                    checked={field.value === true}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            );
          case "select":
          case "matter": {
            const options =
              spec.kind === "matter"
                ? GENERAL_MATTERS.map(([key, m]) => ({
                    value: key,
                    label: `${m.label} (${m.section})`,
                  }))
                : (spec.options ?? []);
            const matter =
              spec.kind === "matter"
                ? MATTERS[String(field.value ?? "")]
                : undefined;
            return (
              <FormItem>
                <FormLabel>{label}</FormLabel>
                <Select
                  value={String(field.value ?? "")}
                  onValueChange={field.onChange}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose…" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {matter ? (
                  <FormDescription>
                    {describeRequirements(matter.requirements)}
                  </FormDescription>
                ) : null}
                <FormMessage />
              </FormItem>
            );
          }
          case "bases":
          case "protected":
          case "members": {
            const options =
              spec.kind === "bases"
                ? VOTE_BASIS_OPTIONS
                : spec.kind === "protected"
                  ? PROTECTED_PROVISIONS.map((p) => ({ value: p, label: p }))
                  : members.map((m) => ({ value: m.id, label: m.name }));
            const selected = asStringArray(field.value);
            return (
              <FormItem>
                <FormLabel>{label}</FormLabel>
                {spec.description ? (
                  <FormDescription>{spec.description}</FormDescription>
                ) : null}
                {options.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No Members to choose from.
                  </p>
                ) : (
                  <div
                    className={cn(
                      "flex flex-col gap-2 rounded-md border p-3",
                      options.length > 8 && "max-h-64 overflow-y-auto",
                    )}
                  >
                    {options.map((o) => (
                      <div key={o.value} className="flex items-start gap-2">
                        <Checkbox
                          id={`${spec.name}-${o.value}`}
                          checked={selected.includes(o.value)}
                          onCheckedChange={(on) =>
                            field.onChange(
                              toggle(selected, o.value, on === true),
                            )
                          }
                        />
                        <label
                          htmlFor={`${spec.name}-${o.value}`}
                          className="text-sm leading-tight"
                        >
                          {o.label}
                        </label>
                      </div>
                    ))}
                  </div>
                )}
                <FormMessage />
              </FormItem>
            );
          }
          default:
            return (
              <FormItem>
                <FormLabel>{label}</FormLabel>
                <FormControl>
                  {spec.kind === "textarea" ? (
                    <Textarea
                      rows={4}
                      {...field}
                      value={String(field.value ?? "")}
                    />
                  ) : spec.kind === "int" ? (
                    <Input
                      type="number"
                      step={1}
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      value={
                        typeof field.value === "number" &&
                        !Number.isNaN(field.value)
                          ? field.value
                          : ""
                      }
                      onChange={(e) => field.onChange(e.target.valueAsNumber)}
                    />
                  ) : (
                    <Input
                      type={spec.kind === "date" ? "date" : "text"}
                      inputMode={spec.kind === "money" ? "decimal" : undefined}
                      pattern={
                        spec.kind === "money"
                          ? "\\d{1,12}(\\.\\d{1,2})?"
                          : undefined
                      }
                      placeholder={spec.kind === "money" ? "0.00" : undefined}
                      {...field}
                      value={String(field.value ?? "")}
                    />
                  )}
                </FormControl>
                {spec.description ? (
                  <FormDescription>{spec.description}</FormDescription>
                ) : null}
                <FormMessage />
              </FormItem>
            );
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// New-resolution flow (step 1: choose a type; step 2: parameters)

interface PresetCard {
  type: ResolutionType;
  description: string;
  section: string;
}

// The purchase-order resolution is the most frequent use and comes first.
const PRESET_CARDS: PresetCard[] = [
  {
    type: "PURCHASE_ORDER",
    description:
      "The Manager signs a resolution for a server purchase order and sends a copy to the Members.",
    section: "6.16(i)(B)",
  },
  {
    type: "GENERAL_CONSENT",
    description: "Ask the Members to consent in writing to a reserved matter.",
    section: "6.9, 6.16",
  },
  {
    type: "RELATED_PARTY",
    description:
      "Approval by the Disinterested Members of a transaction with an insider.",
    section: "6.16(i)",
  },
  {
    type: "TERM_EXTENSION",
    description: "Ask the Preferred Members to extend the term by one year.",
    section: "2.5",
  },
  {
    type: "MANAGER_REMOVAL",
    description: "Removal of the Manager by the Disinterested Members.",
    section: "6.20",
  },
  {
    type: "SUCCESSOR_MANAGER",
    description: "Appoint a successor after removal or resignation.",
    section: "6.20",
  },
  {
    type: "AMENDMENT",
    description: "Amend the Operating Agreement.",
    section: "12.1",
  },
  {
    type: "AUDIT_CALL",
    description: "Require a review or audit of the books at the LLC's expense.",
    section: "8.3",
  },
  {
    type: "MEMBER_LOAN",
    description: "Approve a loan to the LLC by a Member.",
    section: "4.6",
  },
];

export function NewResolutionFlow({
  base,
  members,
  prefill,
}: {
  /** `/<companyPublicId>/resolutions` */
  base: string;
  members: PresetMember[];
  /** Per-type initial values (e.g. PURCHASE_ORDER names from the last one). */
  prefill: Partial<Record<ResolutionType, FormValues>>;
}) {
  const router = useRouter();
  const [type, setType] = useState<ResolutionType | null>(null);
  const create = api.resolution.create.useMutation({
    onSuccess: ({ publicId }) => {
      toast.success("Draft created");
      router.push(`${base}/${publicId}`);
    },
    onError: (error) => toast.error(error.message),
  });

  if (type === null) {
    const [first, ...rest] = PRESET_CARDS;
    return (
      <div className="flex flex-col gap-3">
        {first ? (
          <PresetChoice card={first} featured onChoose={setType} />
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {rest.map((card) => (
            <PresetChoice key={card.type} card={card} onChoose={setType} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>{RESOLUTION_TYPE_LABEL[type]}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResolutionPresetForm
          key={type}
          type={type}
          defaultValues={prefill[type]}
          members={members}
          submitLabel="Create draft"
          pending={create.isPending}
          onCancel={() => setType(null)}
          onSubmit={(params) => create.mutate({ type, params })}
        />
      </CardContent>
    </Card>
  );
}

function PresetChoice({
  card,
  featured = false,
  onChoose,
}: {
  card: PresetCard;
  featured?: boolean;
  onChoose: (type: ResolutionType) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChoose(card.type)}
      className={cn(
        "flex flex-col gap-1 rounded-xl border bg-white p-4 text-left shadow-xs transition-colors hover:border-primary",
        featured && "border-primary/60 bg-primary/5 p-5",
      )}
    >
      <span className="flex items-center gap-2">
        <span className={cn("font-medium", featured && "text-base")}>
          {RESOLUTION_TYPE_LABEL[card.type]}
        </span>
        {featured ? <Badge variant="info">Most used</Badge> : null}
      </span>
      <span className="text-sm text-muted-foreground">{card.description}</span>
      <span className="text-xs text-muted-foreground">
        Section {card.section}
      </span>
    </button>
  );
}
