#!/usr/bin/env python3
"""Deploy a private Tokyo S3 origin and a pay-as-you-go CloudFront HTTPS website."""
import argparse
import json
import subprocess
from pathlib import Path
from media_types import inspect_overrides, load_media_overrides, s3_client

ROOT = Path(__file__).resolve().parents[2]


def template():
    function = '''function handler(event) {
      var request = event.request;
      var uri = request.uri;
      if (uri.endsWith('/')) { request.uri += 'index.html'; }
      else if (!uri.split('/').pop().includes('.')) { request.uri += '/index.html'; }
      return request;
    }'''
    return {
      'AWSTemplateFormatVersion':'2010-09-09',
      'Description':'ChinaTextbookStudyFree static Web: private Tokyo S3 + CloudFront, no VM or domain.',
      'Resources':{
        'WebsiteBucket':{
          'Type':'AWS::S3::Bucket','DeletionPolicy':'Retain','UpdateReplacePolicy':'Retain',
          'Properties':{
            'BucketName':{'Fn::Sub':'china-textbook-web-${AWS::AccountId}-${AWS::Region}'},
            'PublicAccessBlockConfiguration':{'BlockPublicAcls':True,'BlockPublicPolicy':True,
                                            'IgnorePublicAcls':True,'RestrictPublicBuckets':True},
            'OwnershipControls':{'Rules':[{'ObjectOwnership':'BucketOwnerEnforced'}]},
            'BucketEncryption':{'ServerSideEncryptionConfiguration':[
                {'ServerSideEncryptionByDefault':{'SSEAlgorithm':'AES256'}}]},
            'Tags':[{'Key':'Project','Value':'ChinaTextbookStudyFree'}]}},
        'OriginAccessControl':{'Type':'AWS::CloudFront::OriginAccessControl','Properties':{
          'OriginAccessControlConfig':{'Name':{'Fn::Sub':'${AWS::StackName}-s3-oac'},
          'Description':'Only the project CDN can read the website origin.',
          'OriginAccessControlOriginType':'s3','SigningBehavior':'always','SigningProtocol':'sigv4'}}},
        'DirectoryIndex':{'Type':'AWS::CloudFront::Function','Properties':{
          'Name':{'Fn::Sub':'${AWS::StackName}-directory-index'},'AutoPublish':True,
          'FunctionConfig':{'Comment':'Resolve static Next.js directory routes','Runtime':'cloudfront-js-2.0'},
          'FunctionCode':function}},
        'CachePolicy':{'Type':'AWS::CloudFront::CachePolicy','Properties':{'CachePolicyConfig':{
          'Name':{'Fn::Sub':'${AWS::StackName}-origin-cache'},'MinTTL':0,'DefaultTTL':3600,'MaxTTL':31536000,
          'ParametersInCacheKeyAndForwardedToOrigin':{
            'EnableAcceptEncodingBrotli':True,'EnableAcceptEncodingGzip':True,
            'CookiesConfig':{'CookieBehavior':'none'},'HeadersConfig':{'HeaderBehavior':'none'},
            'QueryStringsConfig':{'QueryStringBehavior':'none'}}}}},
        'ResponseHeaders':{'Type':'AWS::CloudFront::ResponseHeadersPolicy','Properties':{
          'ResponseHeadersPolicyConfig':{
            'Name':{'Fn::Sub':'${AWS::StackName}-response-headers'},
            'SecurityHeadersConfig':{
              'ContentTypeOptions':{'Override':True},
              'FrameOptions':{'FrameOption':'SAMEORIGIN','Override':True},
              'ReferrerPolicy':{'ReferrerPolicy':'strict-origin-when-cross-origin','Override':True},
              'StrictTransportSecurity':{'AccessControlMaxAgeSec':31536000,'Override':True}},
            'CustomHeadersConfig':{'Items':[
              {'Header':'Permissions-Policy','Value':'microphone=(self), camera=(), geolocation=()',
               'Override':True}]}}}},
        'Distribution':{'Type':'AWS::CloudFront::Distribution','Properties':{
          'DistributionConfig':{
            'Comment':'ChinaTextbookStudyFree Web - Tokyo private S3 origin - pay as you go',
            'Enabled':True,'DefaultRootObject':'index.html','HttpVersion':'http2and3','IPV6Enabled':True,
            'PriceClass':'PriceClass_200',
            'Origins':[{'Id':'website-s3','DomainName':{'Fn::GetAtt':['WebsiteBucket','RegionalDomainName']},
                        'OriginAccessControlId':{'Ref':'OriginAccessControl'},
                        'S3OriginConfig':{'OriginAccessIdentity':''}}],
            'DefaultCacheBehavior':{
              'TargetOriginId':'website-s3','ViewerProtocolPolicy':'redirect-to-https',
              'AllowedMethods':['GET','HEAD'],'CachedMethods':['GET','HEAD'],'Compress':True,
              'CachePolicyId':{'Ref':'CachePolicy'},'ResponseHeadersPolicyId':{'Ref':'ResponseHeaders'},
              'FunctionAssociations':[{'EventType':'viewer-request','FunctionARN':
                                      {'Fn::GetAtt':['DirectoryIndex','FunctionARN']}}]},
            'CustomErrorResponses':[
              {'ErrorCode':403,'ResponseCode':404,'ResponsePagePath':'/404.html','ErrorCachingMinTTL':10},
              {'ErrorCode':404,'ResponseCode':404,'ResponsePagePath':'/404.html','ErrorCachingMinTTL':10}],
            'ViewerCertificate':{'CloudFrontDefaultCertificate':True}},
          'Tags':[{'Key':'Project','Value':'ChinaTextbookStudyFree'}]}},
        'BucketPolicy':{'Type':'AWS::S3::BucketPolicy','Properties':{
          'Bucket':{'Ref':'WebsiteBucket'},'PolicyDocument':{'Version':'2012-10-17','Statement':[
            {'Sid':'AllowProjectCloudFront','Effect':'Allow','Principal':{'Service':'cloudfront.amazonaws.com'},
             'Action':'s3:GetObject','Resource':{'Fn::Sub':'${WebsiteBucket.Arn}/*'},
             'Condition':{'StringEquals':{'AWS:SourceArn':{'Fn::Sub':
                 'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${Distribution}'}}}},
            {'Sid':'DenyInsecureTransport','Effect':'Deny','Principal':'*','Action':'s3:*',
             'Resource':[{'Fn::GetAtt':['WebsiteBucket','Arn']},{'Fn::Sub':'${WebsiteBucket.Arn}/*'}],
             'Condition':{'Bool':{'aws:SecureTransport':'false'}}}]}}}},
      'Outputs':{
        'BucketName':{'Value':{'Ref':'WebsiteBucket'}},
        'DistributionId':{'Value':{'Ref':'Distribution'}},
        'WebsiteUrl':{'Value':{'Fn::Sub':'https://${Distribution.DomainName}'}}}}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile',default='default')
    parser.add_argument('--region',default='ap-northeast-1')
    parser.add_argument('--stack',default='china-textbook-web')
    parser.add_argument('--site',type=Path,default=ROOT/'deploy-output/site')
    parser.add_argument('--prepare-only',action='store_true')
    parser.add_argument('--infrastructure-only',action='store_true')
    parser.add_argument('--upload-only',action='store_true')
    args=parser.parse_args()
    state_dir=ROOT/'deploy-output';state_dir.mkdir(exist_ok=True)
    template_path=state_dir/'cloudformation.json'
    template_path.write_text(json.dumps(template(),indent=2)+'\n')
    if args.prepare_only:
        print(template_path);return
    if args.region!='ap-northeast-1':raise ValueError('This deployment is scoped to Tokyo.')
    if not args.site.joinpath('index.html').is_file():raise ValueError('Missing verified website export')
    base=['aws','--profile',args.profile,'--region',args.region,'--no-cli-pager']
    def aws(command,capture=False):
        if capture:return json.loads(subprocess.check_output(base+command,text=True))
        subprocess.run(base+command,check=True)
    if not args.upload_only:
        aws(['cloudformation','deploy','--stack-name',args.stack,'--template-file',str(template_path),
             '--tags','Project=ChinaTextbookStudyFree','--no-fail-on-empty-changeset'])
    stack=aws(['cloudformation','describe-stacks','--stack-name',args.stack,'--output','json'],True)['Stacks'][0]
    outputs={x['OutputKey']:x['OutputValue'] for x in stack['Outputs']}
    (state_dir/'aws-state.json').write_text(json.dumps(outputs,indent=2)+'\n')
    print(json.dumps(outputs,indent=2),flush=True)
    if args.infrastructure_only:return
    target='s3://'+outputs['BucketName']+'/'
    # Different cache lifetimes for application pages and immutable hashed assets.
    groups=[('_next','public,max-age=31536000,immutable',None),
            ('audio','public,max-age=31536000,immutable','audio/ogg'),
            ('story-images','public,max-age=3600',None),
            ('textbook-pages','public,max-age=3600',None),
            ('data','public,max-age=300',None)]
    for folder,cache,content_type in groups:
        print('Uploading '+folder,flush=True)
        command=['s3','sync',str(args.site/folder),target+folder+'/',
                 '--cache-control',cache,'--only-show-errors']
        if content_type:command+=['--content-type',content_type]
        if folder=='audio':command+=['--exclude','*.mp3']
        aws(command)
        if folder=='audio':
            # Old Opus remains available to already-open clients. New Web JSON
            # uses real MP3 files; never label those as audio/ogg.
            aws(['s3','sync',str(args.site/folder),target+folder+'/',
                 '--cache-control',cache,'--exclude','*','--include','*.mp3',
                 '--content-type','audio/mpeg','--only-show-errors'])
    print('Uploading website pages',flush=True)
    aws(['s3','sync',str(args.site),target,'--cache-control','public,max-age=0,must-revalidate',
         '--exclude','_next/*','--exclude','audio/*','--exclude','story-images/*',
         '--exclude','textbook-pages/*','--exclude','data/*','--only-show-errors'])
    media_overrides = load_media_overrides(args.site)
    if media_overrides:
        print(f'Checking actual media types for {len(media_overrides)} exceptional objects',flush=True)
        result = inspect_overrides(s3_client(args.profile,args.region),outputs['BucketName'],media_overrides,repair=True)
        (state_dir/'media-type-correction.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result),flush=True)
    aws(['cloudfront','create-invalidation','--distribution-id',outputs['DistributionId'],
         '--paths','/*','--output','json'])
    print('Uploaded: '+outputs['WebsiteUrl'],flush=True)


if __name__=='__main__':main()
