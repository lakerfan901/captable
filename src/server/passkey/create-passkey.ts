import {
  type RegistrationResponseJSON,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { MAXIMUM_PASSKEYS } from "@/constants/passkey";
import { getAuthenticatorOptions } from "@/lib/authenticator";
import { CredentialDeviceTypeEnum } from "@/prisma/enums";
import { db } from "@/server/db";
import type { PasskeyAudit } from "@/trpc/routers/passkey-router/schema";
import { Audit } from "../audit";

type CreatePasskeyOptions = {
  userId: string;
  passkeyName: string;
  verificationResponse: RegistrationResponseJSON;
  auditMetaData: PasskeyAudit;
};

export const createPasskey = async ({
  userId,
  passkeyName,
  verificationResponse,
  auditMetaData,
}: CreatePasskeyOptions) => {
  const { _count, name } = await db.user.findFirstOrThrow({
    where: {
      id: userId,
    },
    include: {
      _count: {
        select: {
          passkeys: true,
        },
      },
    },
  });

  if (_count.passkeys >= MAXIMUM_PASSKEYS) {
    throw new Error("TOO_MANY_PASSKEYS");
  }

  const verificationToken = await db.verificationToken.findFirst({
    where: {
      userId,
      identifier: "PASSKEY_CHALLENGE",
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!verificationToken) {
    throw new Error("Challenge token not found");
  }

  await db.verificationToken.deleteMany({
    where: {
      userId,
      identifier: "PASSKEY_CHALLENGE",
    },
  });

  if (verificationToken.expires < new Date()) {
    throw new Error("Challenge token expired");
  }

  const { rpId: expectedRPID, origin: expectedOrigin } =
    getAuthenticatorOptions();

  const verification = await verifyRegistrationResponse({
    response: verificationResponse,
    expectedChallenge: verificationToken.token,
    expectedOrigin,
    expectedRPID,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Verification failed");
  }

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  await db.$transaction(async (tx) => {
    const passkey = await tx.passkey.create({
      data: {
        userId,
        name: passkeyName,
        // `credential.id` is the base64url credential ID; it is stored as its
        // UTF-8 bytes, matching how existing rows were written and how
        // sign-in looks them up.
        credentialId: Buffer.from(credential.id),
        credentialPublicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        credentialDeviceType:
          credentialDeviceType === "singleDevice"
            ? CredentialDeviceTypeEnum.SINGLE_DEVICE
            : CredentialDeviceTypeEnum.MULTI_DEVICE,
        credentialBackedUp,
        transports: verificationResponse.response.transports,
      },
    });

    const { requestIp, userAgent, companyId } = auditMetaData;

    await Audit.create(
      {
        action: "passkey.created",
        companyId,
        actor: { type: "user", id: userId },
        context: {
          userAgent,
          requestIp,
        },
        target: [{ type: "passkey", id: passkey.id }],
        summary: `${name} created the Passkey ${passkey.name}`,
      },
      tx,
    );
  });
};
