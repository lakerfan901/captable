"use client";

import { NumericFormat, type NumericFormatProps } from "react-number-format";
import { Input } from "@/components/ui/input";

export type MoneyInputProps = Omit<
  NumericFormatProps,
  | "value"
  | "defaultValue"
  | "onChange"
  | "onValueChange"
  | "customInput"
  | "thousandSeparator"
  | "decimalScale"
  | "prefix"
  | "valueIsNumericString"
> & {
  /** Integer cents; null or undefined shows an empty field. */
  value: number | null | undefined;
  /** Called with integer cents (`Math.round(floatValue * 100)`), or null when empty. */
  onChange: (cents: number | null) => void;
};

/** Dollar input (NumericFormat, "$", 2 decimals) whose value is integer cents. */
export function MoneyInput({ value, onChange, ...rest }: MoneyInputProps) {
  return (
    <NumericFormat
      allowNegative={false}
      {...rest}
      customInput={Input}
      thousandSeparator
      decimalScale={2}
      prefix="$"
      value={value === null || value === undefined ? "" : value / 100}
      onValueChange={({ floatValue }) => {
        onChange(
          floatValue === undefined ? null : Math.round(floatValue * 100),
        );
      }}
    />
  );
}
