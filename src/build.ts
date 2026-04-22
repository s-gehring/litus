import packageJson from "../package.json" with { type: "json" };

await Bun.build({
	entrypoints: ["./src/client/app.ts"],
	outdir: "./public",
	naming: "app.js",
	target: "browser",
	minify: false,
	define: {
		LITUS_VERSION: JSON.stringify(packageJson.version),
	},
});

console.log("Client bundle built → public/app.js");
