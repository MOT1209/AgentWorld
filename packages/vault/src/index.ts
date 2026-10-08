export {
  seal,
  open,
  safeEqual,
  resetVaultKeyCache,
  type SealedPayload,
  type CredentialMetadata,
} from "./vault.js";
export {
  createCredential,
  rotateCredential,
  revokeCredential,
  revealCredential,
  findActiveCredential,
  listCredentials,
  credentialMetadata,
  type CreateCredentialInput,
  type CredentialContext,
} from "./credential.service.js";
