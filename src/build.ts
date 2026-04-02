// Module scope required for top-level await
export {};

await Bun.build({
	entrypoints: ["./src/client/app.ts"],
	outdir: "./public",
	naming: "app.js",
	target: "browser",
	minify: false,
});

console.log("Client bundle built → public/app.js");
