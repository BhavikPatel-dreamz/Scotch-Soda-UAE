import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    const { payload, session, topic, shop } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop}`);

    const current = payload.current as string[];
    const scope = current.toString();

    if (session) {
        await db.session.update({   
            where: {
                id: session.id
            },
            data: {
                scope,
            },
        });
    }

    await db.store.updateMany({
        where: { shopDomain: shop },
        data: { scope },
    });

    return new Response();
};
