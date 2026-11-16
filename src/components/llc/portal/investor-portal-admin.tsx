"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { InstantTime } from "@/components/common/instant-time";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  eventLabel,
  filterLogRows,
  filterPeople,
  memberFilterOptions,
  PEOPLE_STATUS_OPTIONS,
  type PeopleStatusFilter,
  plural,
} from "@/lib/portal/share-dialog-view";
import { api } from "@/trpc/react";
import { AccessStatus, RowActions } from "./portal-access-card";

// The team's "Investor portal" page (04-investor-portal.md 6.2; package
// P9a): "People" is `portalAdmin.overview` with the member card's row
// actions; "Activity" is `portalAdmin.accessLog`. The page renders only for
// an LLC and a role with `portal: read`; the row actions need `portal:
// update` and are absent without it.

export function InvestorPortalAdmin({
  companyPublicId,
  tab,
  canUpdate,
  documentPublicId,
}: {
  companyPublicId: string;
  tab: "people" | "activity";
  canUpdate: boolean;
  documentPublicId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const setTab = (next: string) => {
    const params = new URLSearchParams(search.toString());
    if (next === "people") params.delete("tab");
    else params.set("tab", next);
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="people">People</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
      </TabsList>
      <TabsContent value="people">
        <PeopleTab companyPublicId={companyPublicId} canUpdate={canUpdate} />
      </TabsContent>
      <TabsContent value="activity">
        <ActivityTab documentPublicId={documentPublicId} />
      </TabsContent>
    </Tabs>
  );
}

function PeopleTab({
  companyPublicId,
  canUpdate,
}: {
  companyPublicId: string;
  canUpdate: boolean;
}) {
  const utils = api.useUtils();
  const query = api.portalAdmin.overview.useQuery();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<PeopleStatusFilter>("ALL");
  const rows = filterPeople(query.data ?? [], q, status);

  return (
    <Card className="mt-2 w-full">
      <div className="w-full p-6">
        <div className="flex w-full flex-wrap items-center gap-2">
          <Input
            className="h-8 w-64"
            placeholder="Search by member or email..."
            aria-label="Search by member or email"
            value={q}
            maxLength={200}
            onChange={(e) => setQ(e.target.value)}
          />
          <Select
            value={status}
            onValueChange={(v) => setStatus(v as PeopleStatusFilter)}
          >
            <SelectTrigger className="h-8 w-48" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PEOPLE_STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="mt-6 overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Invited</TableHead>
                <TableHead>Last seen</TableHead>
                {canUpdate && (
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={canUpdate ? 6 : 5}
                    className="text-muted-foreground"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              ) : query.error ? (
                <TableRow>
                  <TableCell
                    colSpan={canUpdate ? 6 : 5}
                    className="text-destructive"
                  >
                    {query.error.message}
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={canUpdate ? 6 : 5}
                    className="text-center text-muted-foreground"
                  >
                    {(query.data ?? []).length === 0
                      ? "Nobody has been invited to the portal yet."
                      : "No portal access matches these filters."}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.accessId}>
                    <TableCell className="whitespace-nowrap">
                      <Link
                        href={`/${companyPublicId}/stakeholders/${row.stakeholderId}`}
                        className="font-medium hover:underline"
                      >
                        {row.holderName}
                      </Link>
                    </TableCell>
                    <TableCell className="break-all">{row.email}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <AccessStatus row={row} />
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <InstantTime at={row.invitedAt} dateOnly />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <InstantTime at={row.lastSeenAt} dateOnly />
                    </TableCell>
                    {canUpdate && (
                      <TableCell className="whitespace-nowrap text-right">
                        <RowActions
                          row={row}
                          onChanged={() => {
                            void utils.portalAdmin.overview.invalidate();
                          }}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <p className="pt-4 text-xs text-muted-foreground">
          {plural(rows.length, "row", "rows")}. To invite someone, open the
          member and use “Invite to portal”.
        </p>
      </div>
    </Card>
  );
}

const ALL = "ALL";

function ActivityTab({
  documentPublicId,
}: {
  documentPublicId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const people = api.portalAdmin.overview.useQuery();
  const [member, setMember] = useState<string>(ALL);
  const [item, setItem] = useState("");
  const log = api.portalAdmin.accessLog.useInfiniteQuery(
    {
      ...(member !== ALL && { stakeholderId: member }),
      ...(documentPublicId !== null && { documentPublicId }),
    },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const loaded = (log.data?.pages ?? []).flatMap((p) => p.rows);
  const rows = filterLogRows(loaded, item);
  const members = memberFilterOptions(people.data ?? []);

  return (
    <Card className="mt-2 w-full">
      <div className="w-full p-6">
        <div className="flex w-full flex-wrap items-center gap-2">
          <Select value={member} onValueChange={setMember}>
            <SelectTrigger className="h-8 w-64" aria-label="Member">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All members</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="h-8 w-64"
            placeholder="Filter by item..."
            aria-label="Filter by item"
            value={item}
            maxLength={200}
            onChange={(e) => setItem(e.target.value)}
          />
          {documentPublicId !== null ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.replace(`${pathname}?tab=activity`)}
            >
              Showing one document · Show all
            </Button>
          ) : null}
        </div>
        <div className="mt-6 overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Person</TableHead>
                <TableHead>Member</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Address</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : log.error ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-destructive">
                    {log.error.message}
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    No activity matches these filters.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">
                      <InstantTime at={r.at} />
                    </TableCell>
                    <TableCell className="break-all">
                      {r.portalUserEmail ?? "—"}
                    </TableCell>
                    <TableCell>{r.holder?.name ?? "—"}</TableCell>
                    <TableCell>{eventLabel(r.event)}</TableCell>
                    <TableCell>{r.target?.name ?? "—"}</TableCell>
                    <TableCell className="tabular-nums">
                      {r.ip ?? "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-4">
          <p className="text-xs text-muted-foreground">
            {item.trim() !== ""
              ? `${plural(rows.length, "row", "rows")} of ${loaded.length} loaded match the item filter.`
              : plural(loaded.length, "row", "rows")}
          </p>
          {log.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              loading={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}
            >
              Load more
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
