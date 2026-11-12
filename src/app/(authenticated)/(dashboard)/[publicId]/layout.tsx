import { redirect } from "next/navigation";
import { NavBar } from "@/components/dashboard/navbar";
import { SideBar } from "@/components/dashboard/sidebar";
import { ModalProvider } from "@/components/modals";
import { withServerComponentSession } from "@/server/auth";
import { getCompanyList } from "@/server/company";
import "@/styles/hint.css";
import { RBAC } from "@/lib/rbac";
import { getServerPermissions } from "@/lib/rbac/access-control";
import { EntityProvider } from "@/providers/entity-provider";
import { RolesProvider } from "@/providers/roles-provider";
import { getSessionEntity } from "@/server/entity";

type DashboardLayoutProps = {
  children: React.ReactNode;
  params: Promise<{ publicId: string }>;
};

const DashboardLayout = async (props: DashboardLayoutProps) => {
  const params = await props.params;

  const { publicId } = params;

  const { children } = props;

  const { user } = await withServerComponentSession();

  if (user.companyPublicId !== publicId) {
    redirect(`/${user.companyPublicId}`);
  }

  const [companies, permissionsData, entity] = await Promise.all([
    getCompanyList(user.id),
    getServerPermissions(),
    getSessionEntity(),
  ]);

  const permissions = RBAC.normalizePermissionsMap(permissionsData.permissions);
  return (
    <EntityProvider
      value={{
        entityType: entity.entityType,
        isLlc: entity.isLlc,
        timezone: entity.timezone,
        companyName: entity.name,
      }}
    >
      <RolesProvider data={{ permissions }}>
        <div className="flex min-h-screen bg-gray-50">
          <aside className="sticky top-0 hidden min-h-full w-64 shrink-0 flex-col lg:flex lg:border-r">
            <SideBar
              companies={companies}
              publicId={publicId}
              entityType={entity.entityType}
            />
          </aside>
          <div className="flex h-full grow flex-col">
            <NavBar
              companies={companies}
              publicId={publicId}
              entityType={entity.entityType}
            />
            <div className="mx-auto min-h-full w-full px-5 py-10 lg:px-8 2xl:max-w-(--breakpoint-xl)">
              {children}
            </div>
          </div>
        </div>
        <ModalProvider />
      </RolesProvider>
    </EntityProvider>
  );
};

export default DashboardLayout;
