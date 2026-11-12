import {
  RiCalendar2Line,
  RiListCheck3,
  RiSketching,
  RiText,
} from "@remixicon/react";
import type { FieldTypes } from "@/prisma/enums";

interface OptionsItems {
  label: string;
  icon: typeof RiSketching;
  value: FieldTypes;
}

export const FieldTypeData: OptionsItems[] = [
  {
    label: "Signature",
    icon: RiSketching,
    value: "SIGNATURE",
  },
  {
    label: "Text",
    icon: RiText,
    value: "TEXT",
  },
  {
    label: "Date",
    icon: RiCalendar2Line,
    value: "DATE",
  },
  {
    label: "Select",
    icon: RiListCheck3,
    value: "SELECT",
  },
];
