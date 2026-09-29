import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NOVA — Personal Intelligence", short_name: "NOVA", start_url: "/", display: "standalone", orientation: "portrait",
    background_color: "#02050a", theme_color: "#02050a",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
