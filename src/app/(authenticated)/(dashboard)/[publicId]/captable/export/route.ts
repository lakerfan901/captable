import { renderToBuffer } from "@react-pdf/renderer";
import { toMemberScheduleCsv } from "@/lib/admission/member-schedule-csv";
import { isValidDateOnly, todayInTimeZone } from "@/lib/date-only";
import { RBAC } from "@/lib/rbac";
import { getPermissions } from "@/lib/rbac/access-control";
import { MemberScheduleTemplate } from "@/pdf-templates/member-schedule-template";
import { getServerAuthSession } from "@/server/auth";
import { db } from "@/server/db";
import { loadMemberSchedule } from "@/server/llc/member-schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const text = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

const safe = (s: string) => s.replace(/[^A-Za-z0-9-]/g, "");

export async function GET(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  const { publicId } = await params;

  const session = await getServerAuthSession();
  if (!session?.user?.id) return text(401, "Not signed in");

  // ACTIVE, onboarded membership of the session company, re-read from the DB.
  const { err: permissionError, val: permission } = await getPermissions({
    db,
    session,
  });
  if (permissionError) return text(404, "Not found");

  const company = await db.company.findFirst({
    where: { id: permission.membership.companyId, publicId },
    select: { id: true, name: true, timezone: true, entityType: true },
  });
  if (company?.entityType !== "LLC") {
    return text(404, "Not found");
  }

  const { err: rbacError, val: rbac } = new RBAC()
    .addPolicies({ stakeholder: { allow: ["read"] } })
    .enforce(permission.permissions);
  if (rbacError || !rbac.valid) return text(403, "Forbidden");

  const url = new URL(request.url);
  const format = url.searchParams.get("format");
  if (format !== "pdf" && format !== "csv") {
    return text(400, "format must be pdf or csv");
  }
  const today = todayInTimeZone(company.timezone);
  const requested = url.searchParams.get("asOf");
  if (
    requested !== null &&
    requested !== "" &&
    (!isValidDateOnly(requested) || requested > today)
  ) {
    return text(400, "asOf must be a YYYY-MM-DD date that is not after today");
  }
  const asOf = requested ? requested : undefined;

  const schedule = await loadMemberSchedule(db, company, { asOf });
  const filename = `exhibit-a-${safe(publicId)}-${safe(schedule.asOf)}.${format}`;
  const headers = {
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };

  if (format === "csv") {
    return new Response(toMemberScheduleCsv(schedule), {
      status: 200,
      headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" },
    });
  }

  const pdf = await renderToBuffer(MemberScheduleTemplate({ schedule }));
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: { ...headers, "Content-Type": "application/pdf" },
  });
}
