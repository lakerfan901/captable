import { RiCloseCircleLine } from "@remixicon/react";
import { useFormContext, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  FormControl,
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
import { COLORS } from "@/constants/esign";
import {
  canonicalOptionsFor,
  getSubscriptionFieldKey,
  SUBSCRIPTION_FIELD_KEYS,
} from "@/lib/esign/subscription-fields";
import { cn } from "@/lib/utils";
import {
  type TemplateFieldForm,
  useTemplateEditor,
} from "@/providers/template-field-provider";
import type { RouterOutputs } from "@/trpc/shared";
import { FieldTypeData } from "../field-type-data";
import { CustomFieldRenderer } from "./custom-field-renderer";
import { TemplateFieldContainer } from "./template-field-container";

type Recipients = RouterOutputs["template"]["get"]["recipients"];

interface TemplateFieldProps {
  left: number;
  top: number;
  width: number;
  height: number;
  index: number;
  handleDelete: () => void;
  viewportWidth: number;
  viewportHeight: number;
  currentViewportWidth: number;
  currentViewportHeight: number;
  recipients: Recipients;
}

export function TemplateField({
  height,
  left,
  top,
  width,
  index,
  handleDelete,
  currentViewportHeight,
  currentViewportWidth,
  viewportHeight,
  viewportWidth,
  recipients,
}: TemplateFieldProps) {
  const { control, getValues } = useFormContext<TemplateFieldForm>();
  const { isMaster } = useTemplateEditor();
  const recipientId = useWatch({
    control: control,
    name: `fields.${index}.recipientId`,
  });

  const recipientColors = getValues("recipientColors");
  const color = recipientColors?.[recipientId] ?? "";

  return (
    <TemplateFieldContainer
      viewportWidth={viewportWidth}
      viewportHeight={viewportHeight}
      currentViewportWidth={currentViewportWidth}
      currentViewportHeight={currentViewportHeight}
      width={width}
      top={top}
      left={left}
      height={height}
      color={color}
    >
      <div className="flex items-center gap-x-2">
        <Button
          className="group mt-2"
          variant="ghost"
          size="sm"
          onClick={() => {
            handleDelete();
          }}
        >
          <RiCloseCircleLine className="h-5 w-5 text-red-500/90 group-hover:text-red-500" />
        </Button>

        <FormField
          control={control}
          name={`fields.${index}.type`}
          render={({ field }) => (
            <FormItem>
              <FormLabel className="sr-only">Field type</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger className="trigger group h-8">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {FieldTypeData.map((item) => (
                    <SelectItem key={item.label} value={item.value}>
                      <span className="flex items-center gap-x-2">
                        <item.icon className="h-4 w-4" aria-hidden />
                        <span className="group-[.trigger]:hidden">
                          {item.label}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name={`fields.${index}.name`}
          render={({ field }) => (
            <FormItem>
              <FormLabel className="sr-only">Field Name</FormLabel>
              <FormControl>
                <Input
                  className="h-8 min-w-16"
                  type="text"
                  required
                  {...field}
                />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <RecipientSelect recipients={recipients} index={index} />

      {isMaster && (
        <MeaningSelect
          index={index}
          role={recipients.find((r) => r.id === recipientId)?.role ?? null}
        />
      )}

      <CustomFieldRenderer index={index} />
    </TemplateFieldContainer>
  );
}

interface RecipientSelectProps {
  index: number;
  recipients: Recipients;
}

function RecipientSelect({ index, recipients }: RecipientSelectProps) {
  const { control, getValues } = useFormContext<TemplateFieldForm>();
  const recipientColors = getValues("recipientColors");
  return (
    <FormField
      control={control}
      name={`fields.${index}.recipientId`}
      render={({ field }) => (
        <FormItem>
          <FormLabel>Recipient</FormLabel>
          <Select
            required
            onValueChange={field.onChange}
            defaultValue={field.value}
          >
            <FormControl>
              <SelectTrigger className="h-auto px-2 py-1">
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {recipients.map((recipient) => (
                <SelectItem key={recipient.id} value={recipient.id}>
                  <span className="flex items-center">
                    <span
                      aria-hidden
                      className={cn(
                        "mr-3 rounded-full p-2",
                        COLORS[
                          recipientColors[recipient.id] as keyof typeof COLORS
                        ]?.bg,
                      )}
                    />
                    <span className="flex flex-col items-start">
                      {recipient.name && recipient.name !== "" && (
                        <span>{recipient.name}</span>
                      )}
                      <span className="text-xs text-primary/80">
                        {recipient.email}
                      </span>
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Radix `SelectItem` rejects an empty value, so "None" uses a sentinel. */
const NO_MEANING = "__none__";

interface MeaningSelectProps {
  index: number;
  role: string | null;
}

/**
 * What a master field means (A3.14): the subscription keys of the field's
 * recipient role. Choosing one sets the field's type, name and required flag
 * (and the canonical options of a SELECT key) from the key definition.
 */
function MeaningSelect({ index, role }: MeaningSelectProps) {
  const { control, setValue } = useFormContext<TemplateFieldForm>();
  const keys = SUBSCRIPTION_FIELD_KEYS.filter((key) => key.role === role);

  return (
    <FormField
      control={control}
      name={`fields.${index}.semanticKey`}
      render={({ field }) => (
        <FormItem>
          <FormLabel>Meaning</FormLabel>
          <Select
            value={field.value ?? NO_MEANING}
            onValueChange={(value) => {
              if (value === NO_MEANING) {
                field.onChange(null);
                return;
              }
              const def = getSubscriptionFieldKey(value);
              field.onChange(value);
              if (!def) return;
              setValue(`fields.${index}.type`, def.type);
              setValue(`fields.${index}.name`, def.label);
              setValue(`fields.${index}.required`, def.required);
              const [first, ...rest] = canonicalOptionsFor(value) ?? [];
              if (first) {
                setValue(`fields.${index}.meta`, {
                  options: [first, ...rest],
                });
              }
            }}
          >
            <FormControl>
              <SelectTrigger className="h-auto px-2 py-1">
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              <SelectItem value={NO_MEANING}>None</SelectItem>
              {keys.map((key) => (
                <SelectItem key={key.key} value={key.key}>
                  {key.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
