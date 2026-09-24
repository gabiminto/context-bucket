import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["main.js", "dist/**", "node_modules/**", "prototype/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
  {
    files: ["esbuild.config.mjs", "scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
