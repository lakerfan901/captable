"use client";

import {
  type RemixiconComponentType,
  RiEqualizer2Fill,
  RiEqualizer2Line,
  RiFileTextFill,
  RiFileTextLine,
  RiFolder5Fill,
  RiFolder5Line,
  RiFolderChart2Fill,
  RiFolderChart2Line,
  RiFolderChartFill,
  RiFolderChartLine,
  RiGroup2Fill,
  RiGroup2Line,
  RiHome2Fill,
  RiHome2Line,
  RiListCheck3,
  RiListIndefinite,
  RiMailSendFill,
  RiMailSendLine,
  RiMoneyDollarCircleFill,
  RiMoneyDollarCircleLine,
  RiPieChartFill,
  RiPieChartLine,
  RiSafeFill,
  RiSafeLine,
} from "@remixicon/react";
import { usePathname } from "next/navigation";

import { CaptableLogo } from "@/components/common/logo";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { TGetCompanyList } from "@/server/company";
import { CompanySwitcher } from "./company-switcher";
import {
  type EntityType,
  getCompanyNav,
  getNavSections,
  type NavIconKey,
} from "./nav-config";
import { NavLink } from "./nav-link";

const ICONS: Record<
  NavIconKey,
  { icon: RemixiconComponentType; activeIcon: RemixiconComponentType }
> = {
  home: { icon: RiHome2Line, activeIcon: RiHome2Fill },
  pieChart: { icon: RiPieChartLine, activeIcon: RiPieChartFill },
  group: { icon: RiGroup2Line, activeIcon: RiGroup2Fill },
  folderChart2: { icon: RiFolderChart2Line, activeIcon: RiFolderChart2Fill },
  safe: { icon: RiSafeLine, activeIcon: RiSafeFill },
  money: { icon: RiMoneyDollarCircleLine, activeIcon: RiMoneyDollarCircleFill },
  folder: { icon: RiFolder5Line, activeIcon: RiFolder5Fill },
  mailSend: { icon: RiMailSendLine, activeIcon: RiMailSendFill },
  folderChart: { icon: RiFolderChartLine, activeIcon: RiFolderChartFill },
  list: { icon: RiListIndefinite, activeIcon: RiListCheck3 },
  equalizer: { icon: RiEqualizer2Line, activeIcon: RiEqualizer2Fill },
  fileText: { icon: RiFileTextLine, activeIcon: RiFileTextFill },
};

interface SideBarProps {
  className?: string;
  publicId: string;
  companies: TGetCompanyList;
  entityType: EntityType;
}

export function SideBar({
  className,
  publicId,
  companies,
  entityType,
}: SideBarProps) {
  const currentPath = usePathname();
  const sections = getNavSections(entityType);
  const company = getCompanyNav(entityType).map((item) => ({
    ...item,
    ...ICONS[item.icon],
  }));

  const basePath = `/${publicId}`;

  return (
    <ScrollArea className="h-screen px-3">
      <div className={cn("pb-12", className)}>
        {/* In normal flow (not fixed) so the ScrollArea can scroll a menu
            that is taller than the window. */}
        <div className="gap-y-4 py-4">
          <div className="flex items-center px-1 py-2">
            <CaptableLogo className="h-7 w-auto" />

            <CompanySwitcher companies={companies} publicId={publicId} />
          </div>

          <div className="py-2">
            {sections.map((section) => (
              <div
                key={section.title ?? "main"}
                className={section.title ? "pt-3" : undefined}
              >
                {section.title ? (
                  <div className="text-xs font-semibold leading-6 text-gray-400">
                    {section.title}
                  </div>
                ) : null}
                <ul className="space-y-1">
                  {section.items.map((navItem) => {
                    const item = { ...navItem, ...ICONS[navItem.icon] };
                    const href = basePath + item.href;
                    const isActive =
                      currentPath === href ||
                      (currentPath === basePath && item.href === "/") ||
                      (currentPath.includes(`${item.href}/`) &&
                        item.href !== "/");

                    return (
                      <li key={item.name}>
                        {item.subNav ? (
                          <Accordion type="single" collapsible>
                            <AccordionItem
                              value="item-1"
                              className="border-none"
                            >
                              <div className="flex">
                                {isActive ? (
                                  <item.activeIcon
                                    className={cn(
                                      "ml-1 mr-1 mt-1 inline-block",
                                      "text-primary",
                                      "h-6 w-6 shrink-0",
                                    )}
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <item.icon
                                    className={cn(
                                      "ml-1 mr-1 mt-1 inline-block",
                                      "text-gray-400 group-hover:text-primary",
                                      "h-6 w-6 shrink-0",
                                    )}
                                    aria-hidden="true"
                                  />
                                )}

                                <AccordionTrigger
                                  className={cn(
                                    isActive
                                      ? "bg-gray-50 font-semibold text-primary"
                                      : "text-gray-700 hover:bg-gray-50 hover:text-primary",
                                    "group flex gap-x-3 rounded-md px-2 py-1 text-sm leading-6 hover:no-underline",
                                  )}
                                >
                                  {item.name}
                                </AccordionTrigger>
                              </div>

                              <AccordionContent>
                                <ul className="space-y-1">
                                  {item.subNav.map((subItem) => {
                                    const href =
                                      basePath + item.href + subItem.href;
                                    const isActive =
                                      (subItem.href !== "/" &&
                                        currentPath.includes(
                                          item.href + subItem.href,
                                        )) ||
                                      href === `${currentPath}/`;

                                    return (
                                      <li key={subItem.name}>
                                        <NavLink
                                          active={isActive}
                                          name={subItem.name}
                                          href={href}
                                          className="ml-9"
                                        />
                                      </li>
                                    );
                                  })}
                                </ul>
                              </AccordionContent>
                            </AccordionItem>
                          </Accordion>
                        ) : (
                          <NavLink
                            active={isActive}
                            name={item.name}
                            href={href}
                            icon={isActive ? item.activeIcon : item.icon}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}

            <div className="py-3">
              <div className="text-xs font-semibold leading-6 text-gray-400">
                Company
              </div>
              <ul className="space-y-1">
                {company.map((item) => {
                  const href = basePath + item.href;
                  const isActive =
                    currentPath === href ||
                    (currentPath === basePath && item.href === "/") ||
                    (currentPath.includes(`/${item.href}/`) &&
                      item.href !== "/") ||
                    (currentPath.includes(`${item.rootPath}`) &&
                      item.href !== "/");

                  return (
                    <li key={item.name}>
                      <NavLink
                        active={isActive}
                        name={item.name}
                        href={`${basePath}${item.href}`}
                        icon={isActive ? item.activeIcon : item.icon}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
