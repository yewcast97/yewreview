/**
 * What the bundler understands and the compiler otherwise would not.
 *
 * A stylesheet import is a side effect: it tells Bun to collect the file into the page's CSS, and it
 * has no value to bind. Declared here rather than switched on with `allowArbitraryExtensions`,
 * because that flag would make every unknown extension importable and this project imports exactly
 * one kind.
 */

declare module "*.css";
