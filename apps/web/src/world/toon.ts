/**
 * Shared cel-shading ramp for every modelled asset (characters, buildings, decor),
 * so the whole world reads as one cartoon style.
 */
import * as THREE from "three";

let gradient: THREE.DataTexture | null = null;

/** Three-band ramp (shadow, mid, lit) sampled with nearest filtering. */
export function toonGradientMap(): THREE.DataTexture {
  if (gradient !== null) return gradient;
  const tones = new Uint8Array([110, 110, 110, 255, 185, 185, 185, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(tones, 3, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}
