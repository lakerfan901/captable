import {
  type JWTPayload,
  type JWTVerifyResult,
  jwtVerify,
  SignJWT,
} from "jose";
import { JWT_SECRET } from "@/server/auth";

export const encode = async (data: JWTPayload) => {
  return await new SignJWT(data)
    .setProtectedHeader({ alg: "HS256" })
    .sign(JWT_SECRET);
};

// Verification is pinned to HS256, the only algorithm `encode` signs with
// (L4): a token claiming any other `alg` is rejected before its signature is
// considered.
export const decode = async (data: string) => {
  return await jwtVerify(data, JWT_SECRET, { algorithms: ["HS256"] });
};

export type { JWTPayload, JWTVerifyResult };
