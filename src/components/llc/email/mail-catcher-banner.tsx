import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function MailCatcherBanner() {
  return (
    <Alert variant="destructive">
      <AlertTitle>Emails are not delivered</AlertTitle>
      <AlertDescription>
        Emails are captured by the built-in mail catcher and are not delivered.
        Set EMAIL_SERVER and EMAIL_FROM.
      </AlertDescription>
    </Alert>
  );
}
