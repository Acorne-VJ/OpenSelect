import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OPENSELECT_DIR } from "./config";
import { ensureDir } from "./util";

/** 备份签名密钥（Ed25519）：私钥仅本机保存，公开钥作为信任锚 */
export const KEY_DIR = join(OPENSELECT_DIR, "keys");
export const PRIVATE_KEY_PATH = join(KEY_DIR, "ed25519-private.pem");
export const PUBLIC_KEY_PATH = join(KEY_DIR, "ed25519-public.pem");

export interface KeyInfo {
  privatePath: string;
  publicPath: string;
  /** 公开钥指纹（SHA-256 前 16 hex），用于人工核对信任锚 */
  fingerprint: string;
}

/**
 * 公开钥指纹（SHA-256 前 16 hex）——用于人工核对信任锚，必须是密码学哈希
 * （非密码学哈希可被定向碰撞，核对就失去意义）。
 */
export function publicKeyFingerprint(publicPath = PUBLIC_KEY_PATH): string | null {
  if (!existsSync(publicPath)) return null;
  try {
    const key = createPublicKey(readFileSync(publicPath, "utf8"));
    const der = key.export({ type: "spki", format: "der" }) as Buffer;
    return createHash("sha256").update(der).digest("hex").slice(0, 16);
  } catch {
    return null; // 公钥损坏：无法给指纹（不抛，避免拖垮 status 等只读路径）
  }
}

/**
 * 生成 Ed25519 签名密钥对（默认 ~/.openselect/keys/）。
 * 已存在时默认不覆盖（避免把已信任的公开钥换掉）；force=true 才重建。
 */
export function generateSigningKey(
  force = false,
  paths: { privatePath?: string; publicPath?: string } = {},
): {
  created: boolean;
  info: KeyInfo;
  previousFingerprint?: string | null;
  error?: string;
} {
  const privPath = paths.privatePath ?? PRIVATE_KEY_PATH;
  const pubPath = paths.publicPath ?? PUBLIC_KEY_PATH;
  ensureDir(dirname(privPath));
  try {
    chmodSync(dirname(privPath), 0o700); // 私钥目录不对同机其他用户开放
  } catch {
    /* best effort */
  }
  const previousFingerprint = publicKeyFingerprint(pubPath);
  if (existsSync(pubPath) && !force) {
    // 信任锚已存在：默认不覆盖（换了锚等于换了信任对象）
    if (!existsSync(privPath)) {
      return {
        created: false,
        info: { privatePath: privPath, publicPath: pubPath, fingerprint: previousFingerprint ?? "" },
        previousFingerprint,
        error: "公开钥已存在但私钥缺失：请用 --force 重建（注意：换锚后旧签名将无法验签）",
      };
    }
    return {
      created: false,
      info: { privatePath: privPath, publicPath: pubPath, fingerprint: previousFingerprint ?? "" },
      previousFingerprint,
    };
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  writeFileSync(privPath, privPem, { mode: 0o600 });
  writeFileSync(pubPath, pubPem, { mode: 0o644 });
  try {
    // 确保私钥权限收紧（受 umask 影响）
    chmodSync(privPath, 0o600);
  } catch {
    /* best effort */
  }
  return {
    created: true,
    info: { privatePath: privPath, publicPath: pubPath, fingerprint: publicKeyFingerprint(pubPath) ?? "" },
    previousFingerprint,
  };
}

/** 用本机私钥对数据签名（base64） */
export function signBytes(data: Uint8Array, privateKeyPath = PRIVATE_KEY_PATH): string {
  const key = createPrivateKey(readFileSync(privateKeyPath, "utf8"));
  return sign(null, data, key).toString("base64");
}

/** 用本机公开钥验证签名；没有公开钥时返回 null（无法判定） */
export function verifyBytes(
  data: Uint8Array,
  signatureB64: string,
  publicKeyPath = PUBLIC_KEY_PATH,
): boolean | null {
  if (!existsSync(publicKeyPath)) return null;
  try {
    const key = createPublicKey(readFileSync(publicKeyPath, "utf8"));
    return verify(null, data, key, Buffer.from(signatureB64.trim(), "base64"));
  } catch {
    return false;
  }
}

/** 本机是否已配置信任锚（公开钥） */
export function hasTrustAnchor(publicKeyPath = PUBLIC_KEY_PATH): boolean {
  return existsSync(publicKeyPath);
}
