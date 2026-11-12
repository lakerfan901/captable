import type { TGetCompanyList } from "@/server/company";
import type { EntityType } from "../sidebar/nav-config";
import { CommandMenu } from "./command-menu";
import { MobileDrawer } from "./mobile-drawer";
import { UserDropdown } from "./user-dropdown";

interface SideBarProps {
  publicId: string;
  companies: TGetCompanyList;
  entityType: EntityType;
}

export function NavBar({ publicId, companies, entityType }: SideBarProps) {
  return (
    <div className="sticky top-0 z-50 w-full border-b">
      <header className="flex h-14 items-center bg-gray-50 px-4 lg:px-8">
        <div className="flex w-full items-center justify-between">
          <MobileDrawer
            publicId={publicId}
            companies={companies}
            entityType={entityType}
          />
          <div className="flex items-center gap-6">
            <CommandMenu companyPublicId={publicId} />
            <UserDropdown companyPublicId={publicId} />
          </div>
        </div>
      </header>
    </div>
  );
}
