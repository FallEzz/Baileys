import { SocketConfig, WAMediaUpload, NewsletterMetadata, NewsletterReactionMode, NewsletterViewRole, XWAPaths, NewsletterReaction, NewsletterFetchedUpdate } from '../Types'
import { decryptMessageNode, generateMessageID, generateProfilePicture } from '../Utils'
import { BinaryNode, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } from '../WABinary'
import { makeGroupsSocket } from './groups'

enum QueryIds {
    JOB_MUTATION = '7150902998257522',
    METADATA = '6620195908089573',
    UNFOLLOW = '7238632346214362',
    FOLLOW = '7871414976211147',
    UNMUTE = '7337137176362961',
    MUTE = '25151904754424642',
    CREATE = '6996806640408138',
    ADMIN_COUNT = '7130823597031706',
    CHANGE_OWNER = '7341777602580933',
    DELETE = '8316537688363079',
    DEMOTE = '6551828931592903'
}

export const makeNewsletterSocket = (config: SocketConfig) => {
	const sock = makeGroupsSocket(config)
	const { authState, signalRepository, query, generateMessageTag } = sock

    const encoder = new TextEncoder()

	const newsletterQuery = async(jid: string, type: 'get' | 'set', content: BinaryNode[]) => (
		query({
			tag: 'iq',
			attrs: {
                id: generateMessageTag(),
				type,
				xmlns: 'newsletter',
				to: jid,
			},
			content
		})
	)

    const newsletterWMexQuery = async(jid: string | undefined, query_id: QueryIds, content?: object) => (
        query({
			tag: 'iq',
			attrs: {
                id: generateMessageTag(),
				type: 'get',
				xmlns: 'w:mex',
				to: S_WHATSAPP_NET,
			},
			content: [
                {
                    tag: 'query',
                    attrs: {query_id},
                    content: encoder.encode(JSON.stringify({ variables: { newsletter_id: jid, ...content } }))
                }
            ]
		})
    )

    const parseFetchedUpdates = async(node: BinaryNode, type: 'messages' | 'updates') => {
        let child 
        
        if(type === 'messages') child = getBinaryNodeChild(node, 'messages')
        else {
            const parent = getBinaryNodeChild(node, 'message_updates')
            child = getBinaryNodeChild(parent, 'messages')
        }

        return await Promise.all(getAllBinaryNodeChildren(child!).map(async messageNode => {
            messageNode.attrs.from = child?.attrs.jid as string

            const views = getBinaryNodeChild(messageNode, 'views_count')?.attrs?.count
            const reactionNode = getBinaryNodeChild(messageNode, 'reactions')
            const reactions = getBinaryNodeChildren(reactionNode, 'reaction')
                .map(({ attrs }) => ({ count: +attrs.count, code: attrs.code } as NewsletterReaction))

            let data: NewsletterFetchedUpdate
            if(type === 'messages') {
                const { fullMessage: message, decrypt } = await decryptMessageNode(
                    messageNode,
                    authState.creds.me!.id,
                    authState.creds.me!.lid || '',
                    signalRepository,
                    config.logger
                )
    
                await decrypt()
    
                data = {
                    server_id: messageNode.attrs.server_id,
                    views: views ? +views : undefined,
                    reactions,
                    message
                }
    
                return data
            } else {
                data = {
                    server_id: messageNode.attrs.server_id,
                    views: views ? +views : undefined,
                    reactions
                }

                return data
            }

        }))
    }

    return {
        ...sock,
        subscribeNewsletterUpdates: async(jid: string) => {
            const result = await newsletterQuery(jid, 'set', [{ tag: 'live_updates', attrs: {}, content: [] }])

            return getBinaryNodeChild(result, 'live_updates')?.attrs as { duration: string }
        },

        newsletterReactionMode: async(jid: string, mode: NewsletterReactionMode) => {
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { settings: { reaction_codes: { value: mode }}}
            })
        },

        newsletterUpdateDescription: async(jid: string, description?: string) => {
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { description: description || '', settings: null }
            })
        },

        newsletterUpdateName: async(jid: string, name: string) => {
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { name, settings: null }
            })
        },
        
        newsletterUpdatePicture: async(jid: string, content: WAMediaUpload) => {
            const { img } = await generateProfilePicture(content)

            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { picture: img.toString('base64'), settings: null }
            })
        },

        newsletterRemovePicture: async(jid: string) => {
            await newsletterWMexQuery(jid, QueryIds.JOB_MUTATION, {
                updates: { picture: '', settings: null }
            })
        },

        newsletterUnfollow: async(jid: string) => {
            await newsletterWMexQuery(jid, QueryIds.UNFOLLOW)
        },

        newsletterFollow: async(jid: string) => {
            await newsletterWMexQuery(jid, QueryIds.FOLLOW)
        },

        newsletterUnmute: async(jid: string) => {
            await newsletterWMexQuery(jid, QueryIds.UNMUTE)
        },

        newsletterMute: async(jid: string) => {
            await newsletterWMexQuery(jid, QueryIds.MUTE)
        },

        newsletterCreate: async(name: string, description: string) => {
            await query({
                tag: 'iq',
                attrs: {
                    to: S_WHATSAPP_NET,
                    xmlns: 'tos',
                    id: generateMessageTag(),
                    type: 'set'
                },
                content: [
                    {
                        tag: 'notice',
                        attrs: {
                            id: '20601218',
                            stage: '5'
                        },
                        content: []
                    }
                ]
            })
            const result = await newsletterWMexQuery(undefined, QueryIds.CREATE, {
                input: { name, description }
            })

            return extractNewsletterMetadata(result, true)
        },

        newsletterMetadata: async(type: 'invite' | 'jid', key: string, role?: NewsletterViewRole) => {
            const result = await newsletterWMexQuery(undefined, QueryIds.METADATA, {
                input: {
                    key,
                    type: type.toUpperCase(),
                    view_role: role || 'GUEST'
                },
                fetch_viewer_metadata: true,
                fetch_full_image: true,
                fetch_creation_time: true
            })

            return extractNewsletterMetadata(result)
        },

        newsletterAdminCount: async(jid: string) => {
            const result = await newsletterWMexQuery(jid, QueryIds.ADMIN_COUNT)

            const buff = getBinaryNodeChild(result, 'result')?.content?.toString()
            
            return JSON.parse(buff!).data[XWAPaths.ADMIN_COUNT].admin_count as number
        },

        /**user is Lid, not Jid */
        newsletterChangeOwner: async(jid: string, user: string) => {
            await newsletterWMexQuery(jid, QueryIds.CHANGE_OWNER, {
                user_id: user
            })
        },

        /**user is Lid, not Jid */
        newsletterDemote: async(jid: string, user: string) => {
            await newsletterWMexQuery(jid, QueryIds.DEMOTE, {
                user_id: user
            })
        },

        newsletterDelete: async(jid: string) => {
            await newsletterWMexQuery(jid, QueryIds.DELETE)
        },

        /**if code wasn't passed, the reaction will be removed (if is reacted) */
        newsletterReactMessage: async(jid: string, server_id: string, code?: string) => {
            await query({
                tag: 'message',
                attrs: { to: jid, ...(!code ? { edit: '7' } : {}), type: 'reaction', server_id, id: generateMessageID()},
                content: [{
                    tag: 'reaction',
                    attrs: code ? {code} : {}
                }]
            })
        },

        newsletterFetchMessages: async(type: 'invite' | 'jid', key: string, count: number, after?: number) => {
            const result = await newsletterQuery(S_WHATSAPP_NET, 'get', [
                {
                    tag: 'messages',
                    attrs: { type, ...(type === 'invite' ? {key} : { jid: key }), count: count.toString(), after: after?.toString() || '100' }
                }
            ])

            return await parseFetchedUpdates(result, 'messages')
        },

        newsletterFetchUpdates: async(jid: string, count: number, after?: number, since?: number) => {
            const result = await newsletterQuery(jid, 'get', [
                {
                    tag: 'message_updates',
                    attrs: { count: count.toString(), after: after?.toString() || '100', since: since?.toString() || '0' }
                }
            ])

            return await parseFetchedUpdates(result, 'updates')
        }
    }
}

export const extractNewsletterMetadata = (node: BinaryNode, isCreate?: boolean) => {
    const result = getBinaryNodeChild(node, 'result')?.content?.toString()
    const metadataPath = JSON.parse(result!).data[isCreate ? XWAPaths.CREATE : XWAPaths.NEWSLETTER]

    const metadata: NewsletterMetadata = {
        id: metadataPath.id,
        state: metadataPath.state.type,
        creation_time: +metadataPath.thread_metadata.creation_time,
        name: metadataPath.thread_metadata.name.text,
        nameTime: +metadataPath.thread_metadata.name.update_time,
        description: metadataPath.thread_metadata.description.text,
        descriptionTime: +metadataPath.thread_metadata.description.update_time,
        invite: metadataPath.thread_metadata.invite,
        handle: metadataPath.thread_metadata.handle,
        picture: metadataPath.thread_metadata.picture?.direct_path || null,
        preview: metadataPath.thread_metadata.preview?.direct_path || null,
        reaction_codes: metadataPath.thread_metadata.settings.reaction_codes.value,
        subscribers: +metadataPath.thread_metadata.subscribers_count,
        verification: metadataPath.thread_metadata.verification,
        viewer_metadata: metadataPath.viewer_metadata
    }

    return metadata
}