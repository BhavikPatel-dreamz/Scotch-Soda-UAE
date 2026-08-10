import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

export async function loader({ request }: LoaderFunctionArgs) {
  console.log("[/api/cron/orders-sync] GET hit", request.method);
  return new Response("OK", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  console.log("[/api/cron/orders-sync] action hit", request.method);
  return new Response("OK", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}
