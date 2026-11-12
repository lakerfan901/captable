import { cn } from "@/lib/utils";

type KbdProps = {
  children?: React.ReactNode;
  className?: string;
};

const Kbd = ({ children, className }: KbdProps) => {
  return (
    // <kbd className="shadow-sm font-medium px-1.5 py-0.5 text-xs text-gray-950 bg-gray-50 border border-gray-300 rounded dark:bg-gray-600 dark:text-gray-100 dark:border-gray-500">
    <kbd
      className={cn(
        "inline-flex h-4 select-none items-center gap-1 rounded border bg-muted px-1 font-mono shadow-sm font-medium text-xs",
        className,
      )}
    >
      {children}
    </kbd>
  );
};

export default Kbd;
