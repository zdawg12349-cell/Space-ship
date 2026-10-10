import { LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, Texture, TextureLoader } from 'three';

/** Asset loading with progress reporting. */

export interface AssetBundle {
  earthAlbedo: Texture;
  earthNight: Texture;
  earthData: Texture;
  earthClouds: Texture;
  earthDataImage: ImageData;
  moonAlbedo: Texture;
  moonHeightImage: ImageData;
  milkyWay: Texture;
  starDensity: ImageData;
  stars: ArrayBuffer;
  planets: Record<string, Texture>;
  voiceManifest: Record<string, { role: string; text: string; duration: number }>;
}

const BASE = `${import.meta.env.BASE_URL}assets/`;

export async function loadAssets(onProgress: (f: number, label: string) => void): Promise<AssetBundle> {
  const loader = new TextureLoader();
  let done = 0;
  const total = 22;
  const tick = (label: string) => { done++; onProgress(done / total, label); };
  const tex = (path: string, srgb = true, label = path): Promise<Texture> => new Promise((res, rej) => {
    loader.load(BASE + path, (t) => {
      if (srgb) t.colorSpace = SRGBColorSpace;
      t.anisotropy = 8;
      t.minFilter = LinearMipmapLinearFilter;
      t.magFilter = LinearFilter;
      tick(label);
      res(t);
    }, undefined, rej);
  });
  const image = (path: string): Promise<ImageData> => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      tick(path);
      res(ctx.getImageData(0, 0, img.width, img.height));
    };
    img.onerror = rej;
    img.src = BASE + path;
  });
  const bin = async (path: string) => { const r = await fetch(BASE + path); tick(path); return r.arrayBuffer(); };
  const json = async (path: string) => { const r = await fetch(BASE + path); tick(path); return r.json(); };

  const planetNames = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'saturn_ring', 'uranus', 'neptune', 'sun', 'io', 'europa', 'ganymede', 'callisto'];
  const [earthAlbedo, earthNight, earthData, earthClouds, earthDataImage, moonAlbedo, moonHeightImage, milkyWay, starDensity, stars, voiceManifest, ...planetTex] = await Promise.all([
    tex('earth/albedo.webp', true, 'Earth surface'),
    tex('earth/night.webp', true, 'City lights'),
    tex('earth/data.webp', false, 'Earth data'),
    tex('earth/clouds.webp', false, 'Cloud cover'),
    image('earth/data.webp'),
    tex('moon/albedo.webp', true, 'Lunar surface'),
    image('moon/height.webp'),
    tex('sky/milkyway.webp', true, 'Milky Way'),
    image('sky/stardensity.png'),
    bin('sky/stars.bin'),
    json('audio/voice/manifest.json'),
    ...planetNames.map((n) => tex(`planets/${n}.webp`, n !== 'saturn_ring', n)),
  ]);
  for (const t of [earthAlbedo, earthNight, earthData, earthClouds]) t.wrapS = RepeatWrapping;
  const planets: Record<string, Texture> = {};
  planetNames.forEach((n, i) => { planets[n] = planetTex[i] as Texture; planets[n].wrapS = RepeatWrapping; });
  return {
    earthAlbedo: earthAlbedo as Texture, earthNight: earthNight as Texture, earthData: earthData as Texture, earthClouds: earthClouds as Texture,
    earthDataImage: earthDataImage as ImageData, moonAlbedo: moonAlbedo as Texture, moonHeightImage: moonHeightImage as ImageData,
    milkyWay: milkyWay as Texture, starDensity: starDensity as ImageData, stars: stars as ArrayBuffer, planets,
    voiceManifest: voiceManifest as AssetBundle['voiceManifest'],
  };
}
