-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopName" TEXT,
    "contactEmail" TEXT,
    "accessToken" TEXT,
    "scope" TEXT,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QIVOSToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "refreshTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QIVOSToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT,
    "orderNumber" TEXT,
    "customerShopifyId" TEXT,
    "customerEmail" TEXT,
    "currency" TEXT,
    "subtotalPrice" TEXT,
    "totalPrice" TEXT,
    "discountTotal" TEXT,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "lastWebhookTopic" TEXT,
    "erpStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "loyaltyStatus" TEXT NOT NULL DEFAULT 'NOT_POSTED',
    "paidAt" TIMESTAMP(3),
    "erpSyncedAt" TIMESTAMP(3),
    "loyaltyPostedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Store_shopDomain_key" ON "Store"("shopDomain");

-- CreateIndex
CREATE INDEX "Store_shopDomain_idx" ON "Store"("shopDomain");

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE INDEX "Order_shopDomain_idx" ON "Order"("shopDomain");

-- CreateIndex
CREATE INDEX "Order_erpStatus_idx" ON "Order"("erpStatus");

-- CreateIndex
CREATE INDEX "Order_loyaltyStatus_idx" ON "Order"("loyaltyStatus");

-- CreateIndex
CREATE INDEX "Order_financialStatus_idx" ON "Order"("financialStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopDomain_shopifyOrderId_key" ON "Order"("shopDomain", "shopifyOrderId");

