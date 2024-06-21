/**
 * Get content from WSSharedDoc
 * @param {string} name
 * @param {WSSharedDoc} doc
 */
export const getDocumentData = (name: string, doc: any) => {
    return doc.getXmlFragment(name).toJSON();
}
