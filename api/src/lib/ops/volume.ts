// The volume behind the database claim (D35): its reclaim policy is what keeps the data if the claim is deleted.
export interface VolumeCard {
  name: string;
  reclaimPolicy: string;
  storageClass: string | null;
  capacity: string | null;
}

export function volumeFrom(reply: unknown): VolumeCard {
  const volume = reply as {
    metadata?: { name?: string };
    spec?: {
      persistentVolumeReclaimPolicy?: string;
      storageClassName?: string;
      capacity?: { storage?: string };
    };
  } | null;
  const policy = volume?.spec?.persistentVolumeReclaimPolicy;
  if (!volume?.metadata?.name || !policy) {
    throw new Error("volume: the reply was not the PersistentVolume");
  }
  return {
    name: volume.metadata.name,
    reclaimPolicy: policy,
    storageClass: volume.spec?.storageClassName ?? null,
    capacity: volume.spec?.capacity?.storage ?? null,
  };
}
