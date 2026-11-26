import { notFound } from "next/navigation";
import { SetupFixture } from "./SetupFixture";

export default function DevSetupPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <SetupFixture />;
}
