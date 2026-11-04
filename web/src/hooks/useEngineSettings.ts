import { useQuery } from "@tanstack/react-query";
import { api, type EngineSettingsResponse } from "@/lib/api";

export function useEngineSettings(siteId: string | null | undefined) {
  return useQuery({
    queryKey: ["engine-settings", siteId],
    queryFn: () => api.get<EngineSettingsResponse>(`/settings/engine${siteId ? `?siteId=${siteId}` : ""}`),
  });
}
