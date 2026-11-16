import productConfig from '../../../product.config.json'

const configuredProductName = productConfig.name.trim()

if (!configuredProductName) {
  throw new Error('product.config.json name must not be empty')
}

/** The single product brand. Technical namespaces intentionally remain stable. */
export const PRODUCT_NAME = configuredProductName

/** The user-facing title is the product brand without a surface-specific suffix. */
export const PRODUCT_DISPLAY_NAME = PRODUCT_NAME

/** The extension is another surface of the same product, not a separate brand. */
export const EXTENSION_NAME = PRODUCT_DISPLAY_NAME
